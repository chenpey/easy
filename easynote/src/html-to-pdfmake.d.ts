declare module 'html-to-pdfmake' {
  interface HtmlToPdfmakeOptions {
    window?: Window;
    tableAutoSize?: boolean;
    removeExtraBlanks?: boolean;
    defaultStyles?: Record<string, Record<string, unknown>>;
  }

  export default function htmlToPdfmake(html: string, options?: HtmlToPdfmakeOptions): unknown;
}
