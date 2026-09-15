export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export type NoteInput = Pick<Note, 'title' | 'content' | 'tags' | 'pinned' | 'archived' | 'deletedAt'>;
export type NoteSummary = Omit<Note, 'content'> & { excerpt: string };
export interface Version extends NoteInput {
  revision: number;
  savedAt: number;
  actorType: 'user' | 'ai';
  actorName: string;
}

export interface IntegrationToken {
  id: string;
  name: string;
  access: 'read' | 'read-write';
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface ClientConfig {
  maxNoteBytes: number;
  maxImageBytes: number;
  maxImagePixels: number;
  autosaveMs: number;
  pollSeconds: number;
}

export interface Session {
  user: { id: string; username: string } | null;
  csrf: string | null;
  configured: boolean;
  config: ClientConfig;
}

export interface ImageRecord {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
  url: string;
}

export const noteInput = (note: Note): NoteInput => ({
  title: note.title, content: note.content, tags: note.tags,
  pinned: note.pinned, archived: note.archived, deletedAt: note.deletedAt,
});

export function sameNoteInput(left: NoteInput, right: NoteInput): boolean {
  return left.title === right.title &&
    left.content === right.content &&
    left.pinned === right.pinned &&
    left.archived === right.archived &&
    left.deletedAt === right.deletedAt &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag) => right.tags.includes(tag));
}

export const imagePath = (id: string) => `/api/images/${id}`;
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function imageIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\/api\/images\/([0-9a-f-]{36})(?![0-9a-f-])/gi)]
    .map((match) => match[1]).filter((id) => idPattern.test(id)))];
}
