import type { Note, NoteTask } from './types.js';

export function unfinishedTasks(note: Pick<Note, 'id' | 'title' | 'content' | 'archived' | 'deletedAt'>): NoteTask[] {
  if (note.deletedAt !== null) return [];
  const tasks: NoteTask[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let offset = 0;
  const lines = note.content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      const character = marker[0] as '`' | '~';
      if (!fence) fence = { marker: character, length: marker.length };
      else if (fence.marker === character && marker.length >= fence.length) fence = null;
    } else if (!fence) {
      const match = /^\s*[-+*]\s+\[([ xX]?)\](?:\s+(.*))?$/.exec(line);
      if (match && match[1].toLowerCase() !== 'x') {
        tasks.push({
          noteId: note.id,
          noteTitle: note.title,
          text: (match[2] ?? '').trim() || '未命名待办',
          line: index + 1,
          offset,
          archived: note.archived,
        });
      }
    }
    offset += lines[index].length + (index < lines.length - 1 ? 1 : 0);
  }
  return tasks;
}
