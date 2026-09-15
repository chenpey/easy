import { useEffect, useMemo, useRef } from 'react';
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

const renderer = new MarkdownIt({ html: true, linkify: true, breaks: true });
const defaultFence = renderer.renderer.rules.fence!;
renderer.renderer.rules.fence = (tokens, index, options, env, self) => {
  const language = tokens[index].info.trim().split(/\s+/, 1)[0].toLowerCase();
  if (language === 'mermaid') {
    return `<div data-mermaid-source="true"><pre><code>${renderer.utils.escapeHtml(tokens[index].content)}</code></pre></div>`;
  }
  return defaultFence(tokens, index, options, env, self);
};
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

function renderMarkdown(content: string): string {
  const clean = DOMPurify.sanitize(renderer.render(content), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'data-mermaid-source'],
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
      return;
    }
    const replacement = parsed.createElement('span');
    replacement.className = 'blocked-image';
    replacement.textContent = '[外部图片未加载]';
    image.replaceWith(replacement);
  });
  parsed.body.querySelectorAll('a').forEach((link) => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
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

export function Preview({ content, onImage, dark = false }: { content: string; onImage(src: string): void; dark?: boolean }) {
  const host = useRef<HTMLElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => {
    const elements = [...(host.current?.querySelectorAll<HTMLElement>('[data-mermaid-source]') ?? [])];
    if (!elements.length) return;
    let cancelled = false;
    void (async () => {
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
          themeVariables: {
            fontSize: '14px',
          },
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
    return () => { cancelled = true; };
  }, [html, dark]);

  return <article ref={host} className="markdown" onClick={(event) => {
    if (event.target instanceof HTMLImageElement) onImage(event.target.src);
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
