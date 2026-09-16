import type {
  Content,
  PageOrientation,
  PredefinedPageSize,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces';

const POINTS_PER_MM = 72 / 25.4;
const PAGE_WIDTHS_MM: Record<PdfPageSize, number> = {
  A4: 210,
  LETTER: 215.9,
};
const PAGE_HEIGHTS_MM: Record<PdfPageSize, number> = {
  A4: 297,
  LETTER: 279.4,
};
const PAGE_MARGIN_MM = 18;
const PDF_FONT_PATHS = [
  'fonts/NotoSansSC-Regular.otf',
  'fonts/NotoSansSC-Bold.otf',
] as const;

export type PdfPageSize = 'A4' | 'LETTER';
export type PdfOrientation = PageOrientation;

export interface PdfExportOptions {
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  scale: number;
}

export const defaultPdfOptions: PdfExportOptions = {
  pageSize: 'A4',
  orientation: 'portrait',
  scale: 100,
};

export function pdfFilename(title: string) {
  const safe = title.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[.\s-]+$/g, '')
    .slice(0, 120);
  return `${safe || '未命名笔记'}.pdf`;
}

function pdfResourceUrl(path: string) {
  return new URL(path, new URL(import.meta.env.BASE_URL, document.baseURI)).href;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败。'));
    reader.readAsDataURL(blob);
  });
}

function canvasPng(image: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('图片转换失败。');
  context.drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

async function imageDataUrl(image: HTMLImageElement): Promise<string> {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error(`图片无法写入 PDF：${image.alt || '未命名图片'}`);
  }
  const source = image.currentSrc || image.src;
  if (!source) throw new Error(`图片无法写入 PDF：${image.alt || '未命名图片'}`);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`图片无法写入 PDF：${image.alt || '未命名图片'}`);
  const blob = await response.blob();
  if (blob.type === 'image/png' || blob.type === 'image/jpeg') return blobDataUrl(blob);
  return canvasPng(image);
}

function printableDimensions(options: PdfExportOptions) {
  const portraitWidth = PAGE_WIDTHS_MM[options.pageSize];
  const portraitHeight = PAGE_HEIGHTS_MM[options.pageSize];
  const width = options.orientation === 'portrait' ? portraitWidth : portraitHeight;
  const height = options.orientation === 'portrait' ? portraitHeight : portraitWidth;
  return {
    width: (width - PAGE_MARGIN_MM * 2) * POINTS_PER_MM,
    height: (height - PAGE_MARGIN_MM * 2) * POINTS_PER_MM,
  };
}

async function svgPngDataUrl(svg: SVGSVGElement): Promise<string> {
  const source = svg.cloneNode(true) as SVGSVGElement;
  source.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const width = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
  const height = svg.viewBox.baseVal.height || svg.getBoundingClientRect().height;
  if (width <= 0 || height <= 0) throw new Error('Mermaid 图表尺寸无效。');
  const scale = Math.min(2.5, 2400 / width, 2400 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Mermaid 图表转换失败。');
  const url = URL.createObjectURL(new Blob(
    [new XMLSerializer().serializeToString(source)],
    { type: 'image/svg+xml;charset=utf-8' },
  ));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function replaceDiagrams(source: HTMLElement, target: HTMLElement, printable: { width: number; height: number }) {
  const sourceDiagrams = [...source.querySelectorAll<SVGSVGElement>('.mermaid-diagram svg')];
  const targetDiagrams = [...target.querySelectorAll<SVGSVGElement>('.mermaid-diagram svg')];
  await Promise.all(targetDiagrams.map(async (svg, index) => {
    const original = sourceDiagrams[index];
    if (!original) throw new Error('Mermaid 图表尚未准备完成。');
    const image = document.createElement('img');
    image.src = await svgPngDataUrl(original);
    image.alt = 'Mermaid 图表';
    image.dataset.pdfmake = JSON.stringify({
      fit: [
        Math.round(printable.width),
        Math.round(printable.height * .72),
      ],
    });
    svg.closest('.mermaid-diagram')?.replaceWith(image);
  }));
}

async function exportHtml(source: HTMLElement, options: PdfExportOptions): Promise<string> {
  const article = source.querySelector<HTMLElement>('.markdown');
  if (!article) throw new Error('PDF 正文尚未准备完成。');
  const clone = article.cloneNode(true) as HTMLElement;
  const sourceImages = [...article.querySelectorAll<HTMLImageElement>('img')];
  const clonedImages = [...clone.querySelectorAll<HTMLImageElement>('img')];
  const printable = printableDimensions(options);

  await Promise.all(clonedImages.map(async (image, index) => {
    const original = sourceImages[index];
    if (!original) throw new Error(`图片无法写入 PDF：${image.alt || '未命名图片'}`);
    image.src = await imageDataUrl(original);
    image.removeAttribute('loading');
    image.removeAttribute('width');
    image.removeAttribute('height');
    image.dataset.pdfmake = JSON.stringify({
      fit: [
        Math.round(printable.width),
        Math.round(printable.height * .72),
      ],
    });
  }));

  clone.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.replaceWith(document.createTextNode(checkbox.checked ? '☒ ' : '☐ '));
  });
  clone.querySelectorAll('button').forEach((button) => button.remove());
  clone.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    if (link.dataset.noteId || link.dataset.privateFile || link.dataset.footnoteBackref) {
      link.removeAttribute('href');
    }
  });
  clone.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const columns = Math.max(1, ...[...table.rows].map((row) =>
      [...row.cells].reduce((count, cell) => count + Math.max(1, cell.colSpan), 0)));
    table.dataset.pdfmake = JSON.stringify({
      widths: Array.from({ length: columns }, () => '*'),
      headerRows: table.tHead?.rows.length ?? 0,
    });
  });
  await replaceDiagrams(article, clone, printable);
  clone.querySelectorAll<HTMLElement>('pre').forEach((pre) => {
    pre.style.backgroundColor = '#f5f6f7';
    pre.style.border = '1px solid #d7d9dc';
    pre.style.margin = '6px 0 12px';
  });
  clone.querySelectorAll<HTMLElement>('blockquote').forEach((quote) => {
    quote.style.color = '#5d6268';
    quote.style.margin = '6px 0 12px 12px';
  });
  clone.querySelectorAll<HTMLElement>('mark').forEach((mark) => {
    mark.style.backgroundColor = '#fff2a8';
  });

  return clone.innerHTML;
}

function getPdfBlob(definition: TDocumentDefinitions, fonts: TFontDictionary): Promise<Blob> {
  return new Promise((resolve, reject) => {
    void import('pdfmake/build/pdfmake').then((pdfMake) => {
      try {
        pdfMake.createPdf(definition, undefined, fonts).getBlob(resolve);
      } catch (error) {
        reject(error);
      }
    }, reject);
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('PDF 预览生成失败。')),
      'image/jpeg',
      .9,
    );
  });
}

export async function renderPdfPreviewPages(file: File): Promise<Blob[]> {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await loadingTask.promise;
  const pages: Blob[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 760 / original.width) });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PDF 预览生成失败。');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push(await canvasBlob(canvas));
      canvas.width = 1;
      canvas.height = 1;
      page.cleanup();
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

export async function preparePdfExport() {
  const [, , , { default: workerUrl }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('html-to-pdfmake'),
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  await Promise.all([...PDF_FONT_PATHS.map(pdfResourceUrl), workerUrl].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('PDF 离线资源下载失败。');
    await response.arrayBuffer();
  }));
}

export async function createPdfFile(
  source: HTMLElement,
  filename: string,
  title: string,
  options: PdfExportOptions,
): Promise<File> {
  const scale = Math.min(125, Math.max(75, options.scale)) / 100;
  const html = await exportHtml(source, options);
  const { default: htmlToPdfmake } = await import('html-to-pdfmake');
  const content = htmlToPdfmake(html, {
    window,
    tableAutoSize: false,
    removeExtraBlanks: true,
    defaultStyles: {
      h1: { fontSize: 21 * scale, bold: true, margin: [0, 14, 0, 8] },
      h2: { fontSize: 17 * scale, bold: true, margin: [0, 12, 0, 7] },
      h3: { fontSize: 14 * scale, bold: true, margin: [0, 10, 0, 6] },
      h4: { fontSize: 12 * scale, bold: true, margin: [0, 8, 0, 5] },
      h5: { fontSize: 11 * scale, bold: true, margin: [0, 7, 0, 4] },
      h6: { fontSize: 10 * scale, bold: true, margin: [0, 6, 0, 4] },
      p: { margin: [0, 0, 0, 9 * scale] },
      ul: { margin: [8, 0, 0, 7 * scale] },
      ol: { margin: [8, 0, 0, 7 * scale] },
      pre: { fontSize: 9 * scale, margin: [0, 5, 0, 10] },
      code: { fontSize: 9 * scale, background: '#f5f6f7' },
      a: { color: '#2145a5', decoration: 'underline' },
      table: { margin: [0, 5, 0, 12] },
      th: { bold: true, fillColor: '#f0f1f2' },
      td: { margin: [4, 4, 4, 4] },
    },
  }) as Content;
  const fonts: TFontDictionary = {
    NotoSansSC: {
      normal: pdfResourceUrl(PDF_FONT_PATHS[0]),
      bold: pdfResourceUrl(PDF_FONT_PATHS[1]),
      italics: pdfResourceUrl(PDF_FONT_PATHS[0]),
      bolditalics: pdfResourceUrl(PDF_FONT_PATHS[1]),
    },
  };
  const definition: TDocumentDefinitions = {
    content: html.trim() ? content : { text: '' },
    pageSize: options.pageSize as PredefinedPageSize,
    pageOrientation: options.orientation,
    pageMargins: PAGE_MARGIN_MM * POINTS_PER_MM,
    defaultStyle: {
      font: 'NotoSansSC',
      fontSize: 10.5 * scale,
      lineHeight: 1.5,
      color: '#202428',
    },
    info: {
      title: title.trim() || '未命名笔记',
      creator: 'EasyNote',
      producer: 'EasyNote',
    },
    compress: true,
  };
  const blob = await getPdfBlob(definition, fonts);
  return new File([blob], pdfFilename(filename), { type: 'application/pdf' });
}

export function isMobilePdfTarget() {
  const userAgentData = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof userAgentData.userAgentData?.mobile === 'boolean') return userAgentData.userAgentData.mobile;
  const platform = (navigator as unknown as { platform?: string }).platform;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function downloadPdfFile(file: File) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
