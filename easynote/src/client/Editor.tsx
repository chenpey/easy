import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { idPattern } from '../shared/types';

interface Props {
  value: string;
  onChange(value: string): void;
  onImages(files: File[]): void;
}

export function Editor({ value, onChange, onImages }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onImages });
  callbacks.current = { onChange, onImages };
  const external = useRef(false);
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown(), history(), keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping, placeholder('开始记录…'),
          EditorView.contentAttributes.of({ 'aria-label': '笔记正文', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !external.current) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event) {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length) return false;
              event.preventDefault(); callbacks.current.onImages(files); return true;
            },
            drop(event) {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length) return false;
              event.preventDefault(); callbacks.current.onImages(files); return true;
            },
            dragover(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    external.current = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    external.current = false;
  }, [value]);
  return <div className="code-editor" ref={host} />;
}

const renderer = new MarkdownIt({ html: false, linkify: true, breaks: true });
renderer.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const id = /^\/api\/images\/(.+)$/.exec(src)?.[1];
  if (!id || !idPattern.test(id)) return '<span class="blocked-image">[外部图片未加载]</span>';
  return `<img src="${src}" alt="${renderer.utils.escapeHtml(token.content)}" loading="lazy" />`;
};
renderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};

export function Preview({ content, onImage }: { content: string; onImage(src: string): void }) {
  return <article className="markdown" onClick={(event) => {
    if (event.target instanceof HTMLImageElement) onImage(event.target.src);
  }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderer.render(content), {
    ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'iframe', 'form'],
  }) }} />;
}
