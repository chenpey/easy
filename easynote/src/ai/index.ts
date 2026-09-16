#!/usr/bin/env node
/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  idPattern,
  noteInput,
  type IntegrationNoteSummary,
  type Note,
  type NoteInput,
} from '../shared/types.js';
import { EasyNoteClient } from './client.js';
import { configPathFromArgs, loadConfig, setupConfig } from './config.js';

const noteMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  archived: z.boolean(),
  deletedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
});

const noteResultSchema = z.object({
  note: noteMetadataSchema,
  operationId: z.string(),
});

const noteSearchMatchSchema = z.object({
  field: z.enum(['title', 'content']),
  line: z.number().int().positive().nullable(),
  heading: z.string().nullable(),
  snippet: z.string(),
});

const readNoteSchema = z.object({
  note: noteMetadataSchema,
  content: z.string(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function noteMetadata(note: Note) {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    pinned: note.pinned,
    archived: note.archived,
    deletedAt: note.deletedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
  };
}

function noteResult(note: Note, operationId: string) {
  const result = {
    note: noteMetadata(note),
    operationId,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: `${message}\nRead the note again before retrying. Never overwrite a newer revision.`,
    }],
  };
}

async function save(
  client: EasyNoteClient,
  id: string,
  input: NoteInput,
  revision: number,
  operationId = randomUUID(),
) {
  const result = await client.save(id, input, revision, operationId);
  return noteResult(result.note, operationId);
}

async function recentNotes(client: EasyNoteClient, view: 'all' | 'archive'): Promise<IntegrationNoteSummary[]> {
  const notes: IntegrationNoteSummary[] = [];
  let offset = 0;
  while (notes.length < 50) {
    const page = await client.search({ view, sort: 'updated', limit: Math.min(20, 50 - notes.length), offset });
    notes.push(...page.notes);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return notes;
}

function resourceMarkdown(note: Note): string {
  const title = note.title.replace(/\s+/g, ' ').trim() || 'Untitled note';
  return `# ${title}\n\n${note.content}`;
}

async function createMcpServer(client: EasyNoteClient): Promise<McpServer> {
  const status = await client.status();
  const server = new McpServer({ name: 'easynote-mcp-server', version: '0.1.0' });

  server.registerTool('easynote_search_notes', {
    title: 'Search EasyNote Notes',
    description: 'Search active or archived EasyNote notes by exact substring with full-text relevance ranking, optionally filtering by one exact tag. Returns up to three contextual matches per note plus metadata, resource URIs and offset pagination.',
    inputSchema: z.object({
      query: z.string().max(200).default('').describe('Text matched against title and Markdown body. Chinese substring search is supported.'),
      tag: z.string().max(40).default('').describe('Optional exact tag filter.'),
      view: z.enum(['all', 'archive']).default('all').describe('all means active, non-archived notes; archive means archived notes.'),
      limit: z.number().int().min(1).max(20).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    outputSchema: z.object({
      notes: z.array(noteMetadataSchema.extend({
        excerpt: z.string(),
        matches: z.array(noteSearchMatchSchema).max(3),
        uri: z.string(),
      })),
      count: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
      nextOffset: z.number().nullable(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ query, tag, view, limit, offset }) => {
    try {
      const page = await client.search({ q: query, tag, view, limit, offset });
      const result = {
        notes: page.notes,
        count: page.notes.length,
        offset,
        hasMore: page.nextOffset !== null,
        nextOffset: page.nextOffset,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_read_note', {
    title: 'Read EasyNote Note',
    description: 'Read one EasyNote note by ID. Large Markdown bodies are returned in bounded character ranges; continue with nextOffset when truncated.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes.'),
      offset: z.number().int().min(0).default(0).describe('Character offset in the Markdown body.'),
      limit: z.number().int().min(1).max(50_000).default(25_000).describe('Maximum Markdown characters to return.'),
    }).strict(),
    outputSchema: readNoteSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ id, offset, limit }) => {
    try {
      const note = (await client.note(id)).note;
      const content = note.content.slice(offset, offset + limit);
      const truncated = offset + content.length < note.content.length;
      const result = {
        note: noteMetadata(note),
        content,
        truncated,
        nextOffset: truncated ? offset + content.length : null,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_read_notes', {
    title: 'Read Multiple EasyNote Notes',
    description: 'Read up to 20 EasyNote notes in one request, preserving the requested ID order. Each Markdown body is independently bounded; use easynote_read_note with nextOffset to continue a truncated note.',
    inputSchema: z.object({
      ids: z.array(z.uuid()).min(1).max(20).describe('Stable note IDs returned by easynote_search_notes.'),
      max_chars_per_note: z.number().int().min(1).max(25_000).default(12_000),
    }).strict(),
    outputSchema: z.object({
      notes: z.array(readNoteSchema),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ ids, max_chars_per_note }) => {
    try {
      const notes = (await client.notes(ids)).notes;
      const result = {
        notes: notes.map((note) => {
          const content = note.content.slice(0, max_chars_per_note);
          const truncated = content.length < note.content.length;
          return {
            note: noteMetadata(note),
            content,
            truncated,
            nextOffset: truncated ? content.length : null,
          };
        }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_connection_status', {
    title: 'Get EasyNote Connection Status',
    description: 'Verify the configured EasyNote integration token and return its account, display name and access level.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      account: z.string(),
      integration: z.string(),
      access: z.enum(['read', 'read-write']),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async () => {
    try {
      const result = await client.status();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  const noteTemplate = new ResourceTemplate('easynote://notes/{id}.md', {
    list: async () => {
      const notes = (await Promise.all([
        recentNotes(client, 'all'),
        recentNotes(client, 'archive'),
      ])).flat().sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, 100);
      return {
        resources: notes.map((note) => ({
          uri: `easynote://notes/${note.id}.md`,
          name: note.title || 'Untitled note',
          description: `Revision ${note.revision}${note.tags.length ? `; tags: ${note.tags.join(', ')}` : ''}`,
          mimeType: 'text/markdown',
        })),
      };
    },
  });
  server.registerResource('easynote_note', noteTemplate, {
    title: 'EasyNote Note',
    description: 'A live EasyNote note represented as Markdown.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const id = variables.id;
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('The EasyNote resource URI has an invalid note ID.');
    const note = (await client.note(id)).note;
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: resourceMarkdown(note),
      }],
    };
  });

  if (status.access !== 'read-write') return server;

  server.registerTool('easynote_create_note', {
    title: 'Create EasyNote Note',
    description: 'Create one EasyNote note. This changes cloud data and may create a duplicate if called twice.',
    inputSchema: z.object({
      title: z.string().max(256).describe('Plain note title without a Markdown heading marker.'),
      content: z.string().describe('Markdown body. Use ## for top-level body sections.'),
      tags: z.array(z.string().min(1).max(40)).max(20).default([]),
      pinned: z.boolean().default(false),
      archived: z.boolean().default(false),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ title, content, tags, pinned, archived }) => {
    try {
      return await save(client, randomUUID(), {
        title,
        content,
        tags: [...new Set(tags)],
        pinned,
        archived,
        deletedAt: null,
      }, 0);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_update_note', {
    title: 'Update EasyNote Note',
    description: 'Update selected fields of an existing active or archived note. expected_revision must match the latest read result; a stale revision returns a conflict instead of overwriting user changes.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
      title: z.string().max(256).optional(),
      content: z.string().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    }).strict().refine(({ title, content, tags, pinned, archived }) =>
      title !== undefined || content !== undefined || tags !== undefined || pinned !== undefined || archived !== undefined,
    { message: 'At least one field must be supplied.' }),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ id, expected_revision, ...patch }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is in trash. Restore it in EasyNote before editing.');
      const input = { ...noteInput(current), ...patch };
      if (patch.tags) input.tags = [...new Set(patch.tags)];
      return await save(client, id, input, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_archive_note', {
    title: 'Archive or Restore EasyNote Note',
    description: 'Move an active note into the archive or restore an archived note. expected_revision must match the latest read result.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
      archived: z.boolean().describe('True archives the note; false restores it to all notes.'),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ id, expected_revision, archived }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is in trash and cannot be archived.');
      return await save(client, id, { ...noteInput(current), archived }, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_trash_note', {
    title: 'Move EasyNote Note to Trash',
    description: 'Move one note to EasyNote trash. This never permanently deletes data. expected_revision must match the latest read result.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: {
      ...writeAnnotations,
      destructiveHint: true,
    },
  }, async ({ id, expected_revision }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is already in trash.');
      return await save(client, id, {
        ...noteInput(current),
        archived: false,
        deletedAt: Date.now(),
      }, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

const help = `EasyNote MCP bridge

Usage:
  node dist/ai/index.js setup [--config PATH]
  node dist/ai/index.js mcp [--config PATH]

setup   Interactively store the EasyNote URL and integration token.
mcp     Serve EasyNote read and write tools over MCP stdio.
`;

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(help);
    return;
  }
  const configPath = configPathFromArgs(args);
  if (command === 'setup') {
    await setupConfig(configPath);
    return;
  }
  if (command !== 'mcp') throw new Error(`Unknown command: ${command}\n\n${help}`);
  const config = await loadConfig(configPath);
  const server = await createMcpServer(new EasyNoteClient(config));
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`EasyNote AI: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
