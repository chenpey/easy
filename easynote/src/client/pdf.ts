const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const MARGIN_X_MM = 18;
const MARGIN_TOP_MM = 16;
const MARGIN_BOTTOM_MM = 18;
const CONTENT_WIDTH_MM = A4_WIDTH_MM - MARGIN_X_MM * 2;
const CONTENT_HEIGHT_MM = A4_HEIGHT_MM - MARGIN_TOP_MM - MARGIN_BOTTOM_MM;
const CANVAS_SCALE = 1.5;
const MAX_PAGES = 200;

export function pdfFilename(title: string) {
  const safe = title.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[.\s-]+$/g, '')
    .slice(0, 120);
  return `${safe || '未命名笔记'}.pdf`;
}

function pageSegments(source: HTMLElement, pageHeight: number) {
  const totalHeight = Math.ceil(source.scrollHeight);
  const sourceTop = source.getBoundingClientRect().top;
  const article = source.querySelector('.markdown');
  const blocks = [
    ...source.querySelectorAll<HTMLElement>(':scope > header'),
    ...(article ? [...article.children] as HTMLElement[] : []),
  ];
  const metrics = blocks.map((block) => {
    const rect = block.getBoundingClientRect();
    const margin = Number.parseFloat(getComputedStyle(block).marginBottom) || 0;
    return {
      top: Math.floor(rect.top - sourceTop),
      bottom: Math.ceil(rect.bottom - sourceTop + margin),
      height: Math.ceil(rect.height + margin),
    };
  }).filter(({ bottom }) => bottom > 0);

  const segments: Array<{ offset: number; height: number }> = [];
  let offset = 0;
  while (offset < totalHeight) {
    const target = Math.min(offset + pageHeight, totalHeight);
    let end = target;
    if (target < totalHeight) {
      const crossing = metrics.find(({ top, bottom, height }) =>
        top > offset + 20 && top < target - 8 && bottom > target && height <= pageHeight);
      if (crossing) {
        end = crossing.top;
      } else {
        const minimum = offset + pageHeight * .55;
        const safe = metrics.map(({ bottom }) => bottom)
          .filter((value) => value >= minimum && value <= target - 8).at(-1);
        if (safe) end = safe;
      }
    }
    if (totalHeight - end < 48) end = totalHeight;
    segments.push({ offset, height: Math.max(1, end - offset) });
    offset = end;
    if (segments.length > MAX_PAGES) throw new Error(`PDF 超过 ${MAX_PAGES} 页，无法在移动设备上生成。`);
  }
  return segments;
}

async function waitForImages(root: HTMLElement) {
  await Promise.all([...root.querySelectorAll<HTMLImageElement>('img')].map(async (image) => {
    if (image.complete && image.naturalWidth > 0) return;
    try { await image.decode(); } catch { /* Checked below for a useful error. */ }
    if (!image.complete || image.naturalWidth === 0) throw new Error(`图片无法写入 PDF：${image.alt || '未命名图片'}`);
  }));
}

async function captureSegment(source: HTMLElement, offset: number, height: number, width: number) {
  const viewport = document.createElement('div');
  const content = source.cloneNode(true) as HTMLElement;
  viewport.className = 'pdf-capture-page';
  Object.assign(viewport.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
    background: '#ffffff',
    zIndex: '-10000',
  });
  content.classList.remove('pdf-rendering');
  content.classList.add('pdf-capture-content');
  content.removeAttribute('aria-hidden');
  Object.assign(content.style, {
    display: 'block',
    position: 'absolute',
    left: '0',
    top: `${-offset}px`,
    width: `${width}px`,
  });
  viewport.appendChild(content);
  document.body.appendChild(viewport);
  try {
    await waitForImages(content);
    const { default: html2canvas } = await import('html2canvas');
    return await html2canvas(viewport, {
      backgroundColor: '#ffffff',
      scale: CANVAS_SCALE,
      width: Math.ceil(width),
      height: Math.ceil(height),
      windowWidth: Math.ceil(width),
      windowHeight: Math.ceil(height),
      scrollX: 0,
      scrollY: 0,
      imageTimeout: 15_000,
      logging: false,
      useCORS: false,
    });
  } finally {
    viewport.remove();
  }
}

export async function createPdfFile(source: HTMLElement, title: string) {
  await document.fonts?.ready;
  const width = source.getBoundingClientRect().width;
  if (!Number.isFinite(width) || width <= 0) throw new Error('PDF 页面宽度无效。');
  const pageHeight = width * CONTENT_HEIGHT_MM / CONTENT_WIDTH_MM;
  const segments = pageSegments(source, pageHeight);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  pdf.setProperties({ title: title.trim() || '未命名笔记', creator: 'EasyNote' });

  for (const [index, segment] of segments.entries()) {
    const canvas = await captureSegment(source, segment.offset, segment.height, width);
    if (index > 0) pdf.addPage('a4', 'portrait');
    const imageHeight = segment.height * CONTENT_WIDTH_MM / width;
    pdf.setFillColor(255, 255, 255);
    pdf.rect(0, 0, A4_WIDTH_MM, A4_HEIGHT_MM, 'F');
    pdf.addImage(canvas, 'JPEG', MARGIN_X_MM, MARGIN_TOP_MM, CONTENT_WIDTH_MM, imageHeight, undefined, 'FAST');
    canvas.width = 1;
    canvas.height = 1;
  }

  return new File([pdf.output('blob')], pdfFilename(title), { type: 'application/pdf' });
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
