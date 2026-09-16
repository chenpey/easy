export interface Heading {
  level: number;
  text: string;
  offset: number;
}

export function headings(content: string): Heading[] {
  const result: Heading[] = [];
  let offset = 0;
  let fence = '';
  for (const line of content.split(/\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? '';
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) result.push({ level: heading[1].length, text: heading[2], offset });
    }
    offset += line.length + 1;
  }
  return result;
}

export function noteLink(id: string, title: string): string {
  const label = (title || '未命名笔记').replace(/[\]\|\r\n]/g, ' ').trim().slice(0, 256);
  return `[[${id}|${label}]]`;
}
