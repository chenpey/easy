import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import DOMPurify from 'dompurify';
import { idPattern } from '../shared/types';

interface Props {
  value: string;
  onChange(value: string): void;
  onImages(files: File[], insertion: string): void;
  onTogglePreview(): void;
  onShowShortcuts(): void;
}

export interface EditorHandle {
  markInsertion(): string;
  insertAt(insertion: string, value: string): boolean;
  releaseInsertion(insertion: string): void;
  cursor(): number;
  goTo(offset: number): void;
  focus(): void;
}

function toggleEmphasis(marker: '*' | '**') {
  return (editor: EditorView): boolean => {
    const range = editor.state.selection.main;
    if (range.empty) {
      editor.dispatch({
        changes: { from: range.from, insert: `${marker}${marker}` },
        selection: { anchor: range.from + marker.length },
        scrollIntoView: true,
      });
      return true;
    }
    const document = editor.state.doc;
    let before = 0;
    let after = 0;
    while (range.from - before > 0 && document.sliceString(range.from - before - 1, range.from - before) === '*') before++;
    while (range.to + after < document.length && document.sliceString(range.to + after, range.to + after + 1) === '*') after++;
    const active = marker === '*' ? before % 2 === 1 && after % 2 === 1 : before >= 2 && after >= 2;
    if (active) {
      editor.dispatch({
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        selection: { anchor: range.from - marker.length, head: range.to - marker.length },
        scrollIntoView: true,
      });
    } else {
      editor.dispatch({
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        selection: { anchor: range.from + marker.length, head: range.to + marker.length },
        scrollIntoView: true,
      });
    }
    return true;
  };
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({
  value,
  onChange,
  onImages,
  onTogglePreview,
  onShowShortcuts,
}, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onImages, onTogglePreview, onShowShortcuts });
  const insertions = useRef(new Map<string, number>());
  callbacks.current = { onChange, onImages, onTogglePreview, onShowShortcuts };
  const external = useRef(false);

  const markInsertion = (position?: number) => {
    const id = crypto.randomUUID();
    insertions.current.set(id, position ?? view.current?.state.selection.main.head ?? 0);
    return id;
  };

  useImperativeHandle(ref, () => ({
    markInsertion,
    insertAt(insertion, text) {
      const editor = view.current;
      const marked = insertions.current.get(insertion);
      if (!editor || marked === undefined) return false;
      const position = Math.min(marked, editor.state.doc.length);
      const before = position > 0 && editor.state.doc.sliceString(position - 1, position) !== '\n' ? '\n\n' : '';
      const after = position < editor.state.doc.length && editor.state.doc.sliceString(position, position + 1) !== '\n' ? '\n\n' : '\n';
      const inserted = `${before}${text}${after}`;
      editor.dispatch({
        changes: { from: position, insert: inserted },
        selection: { anchor: position + inserted.length },
        scrollIntoView: true,
      });
      insertions.current.set(insertion, position + inserted.length);
      editor.focus();
      return true;
    },
    releaseInsertion(insertion) { insertions.current.delete(insertion); },
    cursor() { return view.current?.state.selection.main.head ?? 0; },
    goTo(offset) {
      const editor = view.current;
      if (!editor) return;
      const position = Math.max(0, Math.min(offset, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      editor.focus();
    },
    focus() { view.current?.focus(); },
  }), []);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown(), history(), keymap.of([
            { key: 'Mod-b', run: toggleEmphasis('**') },
            { key: 'Mod-i', run: toggleEmphasis('*') },
            { key: 'Ctrl-e', run: () => { callbacks.current.onTogglePreview(); return true; } },
            { key: 'Meta-e', run: () => { callbacks.current.onTogglePreview(); return true; } },
            { key: 'Mod-Enter', run: () => { callbacks.current.onTogglePreview(); return true; } },
            { key: 'Mod-/', run: () => { callbacks.current.onShowShortcuts(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping, placeholder('开始记录…'),
          EditorView.contentAttributes.of({
            'aria-label': '笔记正文',
            'aria-keyshortcuts': 'Meta+B Control+B Meta+I Control+I Meta+E Control+E Meta+Enter Control+Enter Meta+/ Control+/',
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              for (const [id, position] of insertions.current) {
                insertions.current.set(id, update.changes.mapPos(position, -1));
              }
            }
            if (update.docChanged && !external.current) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event) {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion());
              return true;
            },
            drop(event, editorView) {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion(editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined));
              return true;
            },
            dragover(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; insertions.current.clear(); };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    external.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    external.current = false;
  }, [value]);
  return <div className="code-editor" ref={host} />;
});

const renderer = new MarkdownIt({ html: true, linkify: true, breaks: true }).use(footnote);
renderer.core.ruler.after('block', 'source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting === 1) token.attrSet('data-source-line', String(token.map[0]));
  }
});
const defaultText = renderer.renderer.rules.text;
renderer.renderer.rules.text = (tokens, index, options, env, self) => {
  const rendered = defaultText
    ? defaultText(tokens, index, options, env, self)
    : renderer.utils.escapeHtml(tokens[index].content);
  return rendered.replace(/\[\[([0-9a-f-]{36})\|([^\]\r\n]{1,256})\]\]/gi, (source, id: string, label: string) =>
    idPattern.test(id) ? `<a href="#note-${id}" data-note-id="${id}">${label}</a>` : source);
};
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/, 1)[0].toLowerCase();
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  const source = renderer.utils.escapeHtml(token.content);
  if (language === 'mermaid') {
    return `<div data-mermaid-source="true"${sourceLine}><pre><code>${source}</code></pre></div>`;
  }
  return `<pre${sourceLine}><code data-code-language="${renderer.utils.escapeHtml(language)}">${source}</code></pre>\n`;
};
renderer.renderer.rules.code_block = (tokens, index) => {
  const token = tokens[index];
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  return `<pre${sourceLine}><code data-code-language="">${renderer.utils.escapeHtml(token.content)}</code></pre>\n`;
};
renderer.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const id = /^\/api\/images\/(.+)$/.exec(src)?.[1];
  if (!id || !idPattern.test(id)) return '<span class="blocked-image">[外部图片未加载]</span>';
  return `<img src="${src}" data-private-image="${id}" alt="${renderer.utils.escapeHtml(token.content)}" loading="lazy" />`;
};
renderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const href = tokens[index].attrGet('href') ?? '';
  const id = /^\/api\/files\/(.+)$/.exec(href)?.[1];
  if (id && idPattern.test(id)) {
    tokens[index].attrSet('data-private-file', id);
    tokens[index].attrSet('download', '');
  } else {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, index, options);
};
renderer.renderer.rules.footnote_ref = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return `<sup><a href="#footnote-${number}" data-footnote-ref="${number}" data-footnote-reference="${reference}">[${reference}]</a></sup>`;
};
renderer.renderer.rules.footnote_block_open = () =>
  '<hr data-footnotes-separator>\n<section data-footnotes>\n<ol>\n';
renderer.renderer.rules.footnote_block_close = () => '</ol>\n</section>\n';
renderer.renderer.rules.footnote_open = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  return `<li data-footnote-id="${number}">`;
};
renderer.renderer.rules.footnote_close = () => '</li>\n';
renderer.renderer.rules.footnote_anchor = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return ` <a href="#footnote-ref-${reference}" data-footnote-backref="${reference}" aria-label="返回脚注引用">↩︎</a>`;
};

export function toggleMarkdownTask(content: string, taskIndex: number, checked: boolean): string {
  let index = 0;
  return content.replace(/^(\s*[-+*]\s+)\[([ xX]?)\](?=\s|$)/gm, (source, prefix: string) => {
    if (index++ !== taskIndex) return source;
    return `${prefix}[${checked ? 'x' : ' '}]`;
  });
}

function renderMarkdown(content: string, interactiveTasks: boolean): string {
  const clean = DOMPurify.sanitize(renderer.render(content), {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      'target', 'download', 'data-source-line', 'data-code-language', 'data-mermaid-source',
      'data-note-id', 'data-private-image', 'data-private-file', 'data-footnotes',
      'data-footnotes-separator', 'data-footnote-id', 'data-footnote-ref',
      'data-footnote-reference', 'data-footnote-backref',
    ],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style', 'script', 'iframe', 'form', 'input', 'button', 'select', 'option', 'textarea',
      'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track',
    ],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'class'],
  });
  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  parsed.body.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? '';
    const id = /^\/api\/images\/(.+)$/.exec(src)?.[1];
    if (id && idPattern.test(id)) {
      image.setAttribute('loading', 'lazy');
      image.setAttribute('data-private-image', id);
      return;
    }
    const replacement = parsed.createElement('span');
    replacement.className = 'blocked-image';
    replacement.textContent = '[外部图片未加载]';
    image.replaceWith(replacement);
  });
  parsed.body.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    if (link.dataset.footnoteRef || link.dataset.footnoteBackref) {
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const noteId = link.dataset.noteId;
    if (noteId && idPattern.test(noteId)) {
      link.href = `#note-${noteId}`;
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const fileId = /^\/api\/files\/(.+)$/.exec(link.getAttribute('href') ?? '')?.[1];
    if (fileId && idPattern.test(fileId)) {
      link.dataset.privateFile = fileId;
      link.setAttribute('download', '');
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
  let taskIndex = 0;
  parsed.body.querySelectorAll<HTMLLIElement>('li').forEach((item) => {
    const holder = item.firstElementChild?.tagName === 'P' ? item.firstElementChild : item;
    const text = [...holder.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    const match = /^(\s*)\[([ xX]?)\](?:\s+|$)/.exec(text?.textContent ?? '');
    if (!text || !match) return;
    const checked = match[2].toLocaleLowerCase() === 'x';
    text.textContent = `${match[1]}${text.textContent!.slice(match[0].length)}`;
    const checkbox = parsed.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.taskIndex = String(taskIndex++);
    checkbox.setAttribute('aria-label', `待办事项：${item.textContent?.trim() || '未命名'}`);
    if (checked) {
      checkbox.checked = true;
      checkbox.setAttribute('checked', '');
      item.classList.add('done');
    }
    if (!interactiveTasks) checkbox.disabled = true;
    item.classList.add('task-list-item');
    item.parentElement?.classList.add('task-list');
    holder.insertBefore(checkbox, holder.firstChild);
  });
  return parsed.body.innerHTML;
}

function diagramError(element: HTMLElement, error: unknown) {
  element.className = 'mermaid-error';
  element.removeAttribute('data-mermaid-source');
  element.textContent = `图表无法渲染：${String(error).split('\n', 1)[0]}`;
}

function fitDiagramToContainer(element: HTMLElement) {
  const svg = element.querySelector<SVGSVGElement>('svg');
  const width = svg?.viewBox.baseVal.width ?? 0;
  if (!svg || width <= 0) return;
  svg.style.width = `${Math.ceil(width)}px`;
  svg.style.maxWidth = '100%';
  svg.style.height = 'auto';
}

export function Preview({
  content,
  onImage,
  onNote,
  onFile,
  onTask,
  resolveFile,
  dark = false,
  eagerImages = false,
  onEditLine,
}: {
  content: string;
  onImage(src: string): void;
  onNote?(id: string): void;
  onFile?(id: string, href: string): void;
  onTask?(index: number, checked: boolean): void;
  resolveFile?(id: string): Promise<string | null>;
  dark?: boolean;
  eagerImages?: boolean;
  onEditLine?(line: number): void;
}) {
  const host = useRef<HTMLElement>(null);
  const html = useMemo(() => renderMarkdown(content, !!onTask), [content, !!onTask]);
  useEffect(() => {
    const elements = [...(host.current?.querySelectorAll<HTMLElement>('[data-mermaid-source]') ?? [])];
    const codeBlocks = [...(host.current?.querySelectorAll<HTMLElement>('code[data-code-language]') ?? [])];
    const privateImages = [...(host.current?.querySelectorAll<HTMLImageElement>('img[data-private-image]') ?? [])];
    const objectUrls: string[] = [];
    let cancelled = false;
    if (eagerImages) privateImages.forEach((image) => { image.loading = 'eager'; });
    if (resolveFile) {
      for (const image of privateImages) {
        const id = image.dataset.privateImage;
        if (!id) continue;
        let attempted = false;
        const useCached = () => {
          if (attempted) return;
          attempted = true;
          void resolveFile(id).then((url) => {
            if (!url) return;
            if (cancelled) URL.revokeObjectURL(url);
            else { objectUrls.push(url); image.src = url; }
          });
        };
        image.addEventListener('error', useCached, { once: true });
        if (!navigator.onLine || image.complete && image.naturalWidth === 0) useCached();
      }
    }
    if (codeBlocks.some((code) => code.dataset.codeLanguage)) void (async () => {
      const { default: highlighter } = await import('highlight.js/lib/common');
      if (cancelled) return;
      for (const code of codeBlocks) {
        const language = code.dataset.codeLanguage ?? '';
        if (!language || !highlighter.getLanguage(language)) continue;
        try {
          code.innerHTML = highlighter.highlight(code.textContent ?? '', { language, ignoreIllegals: true }).value;
          code.classList.add('hljs');
        } catch { /* Keep escaped plain text when a language cannot be highlighted. */ }
      }
    })();
    if (elements.length) void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          htmlLabels: false,
          maxTextSize: 50_000,
          maxEdges: 500,
          secure: [
            'secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges',
            'theme', 'look', 'layout', 'themeVariables', 'themeCSS', 'fontFamily', 'htmlLabels',
          ],
          theme: dark ? 'dark' : 'default',
          look: 'classic',
          layout: 'dagre',
          themeVariables: { fontSize: '14px' },
          flowchart: {
            curve: 'basis',
            htmlLabels: false,
            useMaxWidth: false,
            diagramPadding: 4,
            nodeSpacing: 30,
            rankSpacing: 35,
          },
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        });
        for (const [index, element] of elements.entries()) {
          if (cancelled) return;
          const source = element.textContent?.trim() ?? '';
          if (!source || source.length > 50_000 || index >= 20) {
            diagramError(element, source ? '图表内容过大或数量超过 20 个。' : '图表内容为空。');
            continue;
          }
          try {
            const id = `easynote-diagram-${crypto.randomUUID()}`;
            const { svg, bindFunctions } = await mermaid.render(id, source);
            if (cancelled) return;
            element.innerHTML = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              ADD_TAGS: ['style'],
            });
            element.className = 'mermaid-diagram';
            element.removeAttribute('data-mermaid-source');
            fitDiagramToContainer(element);
            bindFunctions?.(element);
          } catch (error) {
            diagramError(element, error);
          }
        }
      } catch (error) {
        if (!cancelled) elements.forEach((element) => diagramError(element, error));
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [html, dark, resolveFile, eagerImages]);

  return <article ref={host} className="markdown" onDoubleClick={(event) => {
    if (!onEditLine) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, img, summary')) return;
    const block = target.closest<HTMLElement>('[data-source-line]');
    const line = Number(block?.dataset.sourceLine);
    if (Number.isInteger(line) && line >= 0) onEditLine(line);
  }} onClick={(event) => {
    const target = event.target as HTMLElement;
    const footnoteRef = target.closest<HTMLAnchorElement>('a[data-footnote-ref]');
    if (footnoteRef) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(`[data-footnote-id="${footnoteRef.dataset.footnoteRef}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const footnoteBackref = target.closest<HTMLAnchorElement>('a[data-footnote-backref]');
    if (footnoteBackref) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(
        `[data-footnote-reference="${footnoteBackref.dataset.footnoteBackref}"]`
      )?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const task = target.closest<HTMLInputElement>('input[data-task-index]');
    if (task && onTask) {
      onTask(Number(task.dataset.taskIndex), task.checked);
      return;
    }
    const image = target.closest<HTMLImageElement>('img[data-private-image]');
    if (image) { onImage(image.src); return; }
    const note = target.closest<HTMLAnchorElement>('a[data-note-id]');
    if (note?.dataset.noteId && onNote) {
      event.preventDefault();
      onNote(note.dataset.noteId);
      return;
    }
    const file = target.closest<HTMLAnchorElement>('a[data-private-file]');
    if (file?.dataset.privateFile && onFile) {
      event.preventDefault();
      onFile(file.dataset.privateFile, file.href);
    }
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
