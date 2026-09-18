import { diff3Merge } from 'node-diff3';
import { noteInput, type Note, type NoteInput } from '../shared/types';

export type NoteConflictField = keyof NoteInput;
export type ConflictPreference = 'local' | 'remote';

export interface NoteMergeResult {
  note: Note;
  conflicts: NoteConflictField[];
}

const inputFields: NoteConflictField[] = ['title', 'content', 'tags', 'pinned', 'archived', 'deletedAt'];
const maxLineMergeWork = 250_000;

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag) => right.includes(tag));
}

function sameField<K extends NoteConflictField>(field: K, left: NoteInput[K], right: NoteInput[K]): boolean {
  return field === 'tags'
    ? sameTags(left as string[], right as string[])
    : left === right;
}

function mergeScalar<K extends Exclude<NoteConflictField, 'content' | 'tags'>>(
  field: K,
  base: NoteInput[K],
  local: NoteInput[K],
  remote: NoteInput[K],
  preference: ConflictPreference,
): { value: NoteInput[K]; conflict: boolean } {
  if (sameField(field, local, remote) || sameField(field, remote, base)) return { value: local, conflict: false };
  if (sameField(field, local, base)) return { value: remote, conflict: false };
  return { value: preference === 'local' ? local : remote, conflict: true };
}

function mergeTags(base: string[], local: string[], remote: string[]): string[] {
  const values = [...new Set([...remote, ...local, ...base])];
  return values.filter((tag) => {
    const original = base.includes(tag);
    const localValue = local.includes(tag);
    const remoteValue = remote.includes(tag);
    if (localValue === remoteValue) return localValue;
    return localValue === original ? remoteValue : localValue;
  });
}

function textTokens(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function mergeText(
  base: string,
  local: string,
  remote: string,
  preference: ConflictPreference,
): { value: string; conflict: boolean } {
  if (local === remote || remote === base) return { value: local, conflict: false };
  if (local === base) return { value: remote, conflict: false };
  const localTokens = textTokens(local);
  const baseTokens = textTokens(base);
  const remoteTokens = textTokens(remote);
  if (baseTokens.length * Math.max(localTokens.length, remoteTokens.length) > maxLineMergeWork) {
    return { value: preference === 'local' ? local : remote, conflict: true };
  }
  const regions = diff3Merge(localTokens, baseTokens, remoteTokens, {
    excludeFalseConflicts: true,
  });
  let conflict = false;
  const result: string[] = [];
  for (const region of regions) {
    if (region.ok) result.push(...region.ok);
    else if (region.conflict) {
      const localText = region.conflict.a.join('');
      const baseText = region.conflict.o.join('');
      const remoteText = region.conflict.b.join('');
      if (localText.length + baseText.length + remoteText.length <= 12_000) {
        const refined = diff3Merge(Array.from(localText), Array.from(baseText), Array.from(remoteText), {
          excludeFalseConflicts: true,
        });
        for (const detail of refined) {
          if (detail.ok) result.push(detail.ok.join(''));
          else if (detail.conflict) {
            conflict = true;
            result.push(detail.conflict[preference === 'local' ? 'a' : 'b'].join(''));
          }
        }
      } else {
        conflict = true;
        result.push(preference === 'local' ? localText : remoteText);
      }
    }
  }
  return { value: result.join(''), conflict };
}

function changedFields(base: NoteInput, value: NoteInput): NoteConflictField[] {
  return inputFields.filter((field) => !sameField(field, base[field] as never, value[field] as never));
}

export function mergeNoteChanges(
  baseNote: Note,
  localNote: Note,
  remoteNote: Note,
  preference: ConflictPreference = 'local',
): NoteMergeResult {
  const base = noteInput(baseNote);
  const local = noteInput(localNote);
  const remote = noteInput(remoteNote);
  const conflicts: NoteConflictField[] = [];

  const title = mergeScalar('title', base.title, local.title, remote.title, preference);
  if (title.conflict) conflicts.push('title');
  const content = mergeText(base.content, local.content, remote.content, preference);
  if (content.conflict) conflicts.push('content');
  const pinned = mergeScalar('pinned', base.pinned, local.pinned, remote.pinned, preference);
  if (pinned.conflict) conflicts.push('pinned');
  const archived = mergeScalar('archived', base.archived, local.archived, remote.archived, preference);
  if (archived.conflict) conflicts.push('archived');
  const deletedAt = mergeScalar('deletedAt', base.deletedAt, local.deletedAt, remote.deletedAt, preference);
  if (deletedAt.conflict) conflicts.push('deletedAt');

  const localChanges = changedFields(base, local);
  const remoteChanges = changedFields(base, remote);
  const deletionOverlapsAnotherChange =
    localChanges.includes('deletedAt') && remoteChanges.some((field) => field !== 'deletedAt') ||
    remoteChanges.includes('deletedAt') && localChanges.some((field) => field !== 'deletedAt');
  if (deletionOverlapsAnotherChange) {
    deletedAt.value = preference === 'local' ? local.deletedAt : remote.deletedAt;
    if (!conflicts.includes('deletedAt')) conflicts.push('deletedAt');
  }

  return {
    note: {
      ...remoteNote,
      title: title.value,
      content: content.value,
      tags: mergeTags(base.tags, local.tags, remote.tags),
      pinned: pinned.value,
      archived: archived.value,
      deletedAt: deletedAt.value,
    },
    conflicts,
  };
}
