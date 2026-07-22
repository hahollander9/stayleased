import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/** Small PDF composer over pdf-lib: headers, key/values, auto-paginating
 * tables. Used for statements, SODAs, adverse-action letters, lease packets,
 * reports, 1099 summaries. */

const INK = rgb(0.11, 0.14, 0.19);
const MUTED = rgb(0.42, 0.46, 0.52);
const LINE = rgb(0.88, 0.9, 0.92);
const ACCENT = rgb(0.27, 0.33, 0.9);

export interface PdfTableCol {
  label: string;
  w: number; // fraction of width, sums ~1
  align?: 'left' | 'right';
}

export class Pdf {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private margin = 46;
  private width = 0;
  readonly titleText: string;

  private constructor(title: string) {
    this.titleText = title;
  }

  static async create(title: string): Promise<Pdf> {
    const p = new Pdf(title);
    p.doc = await PDFDocument.create();
    p.doc.setTitle(title);
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.addPage();
    return p;
  }

  addPage(): void {
    this.page = this.doc.addPage([612, 792]); // letter
    this.width = 612 - this.margin * 2;
    this.y = 792 - this.margin;
  }

  private ensure(h: number): void {
    if (this.y - h < this.margin) this.addPage();
  }

  brandHeader(orgLine: string, subLines: string[] = []): void {
    this.page.drawText('ORIEL', { x: this.margin, y: this.y - 12, size: 13, font: this.bold, color: ACCENT });
    this.page.drawText(orgLine, { x: this.margin + 52, y: this.y - 12, size: 10.5, font: this.bold, color: INK });
    let yy = this.y - 25;
    for (const line of subLines) {
      this.page.drawText(line, { x: this.margin + 52, y: yy, size: 8.5, font: this.font, color: MUTED });
      yy -= 11;
    }
    this.y = yy - 8;
    this.hr();
  }

  h1(text: string): void {
    this.ensure(30);
    this.page.drawText(text, { x: this.margin, y: this.y - 16, size: 15, font: this.bold, color: INK });
    this.y -= 26;
  }

  h2(text: string): void {
    this.ensure(24);
    this.page.drawText(text, { x: this.margin, y: this.y - 13, size: 11, font: this.bold, color: INK });
    this.y -= 20;
  }

  text(str: string, opts: { size?: number; muted?: boolean; bold?: boolean } = {}): void {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const lines = this.wrap(str, this.width, size, font);
    for (const line of lines) {
      this.ensure(size + 5);
      this.page.drawText(line, { x: this.margin, y: this.y - size, size, font, color: opts.muted ? MUTED : INK });
      this.y -= size + 4;
    }
    this.y -= 2;
  }

  kv(pairs: [string, string][]): void {
    for (const [k, v] of pairs) {
      this.ensure(14);
      this.page.drawText(k, { x: this.margin, y: this.y - 10, size: 9, font: this.font, color: MUTED });
      this.page.drawText(v, { x: this.margin + 150, y: this.y - 10, size: 9.5, font: this.bold, color: INK });
      this.y -= 15;
    }
    this.y -= 4;
  }

  hr(): void {
    this.ensure(10);
    this.page.drawLine({
      start: { x: this.margin, y: this.y - 4 },
      end: { x: this.margin + this.width, y: this.y - 4 },
      thickness: 0.7,
      color: LINE,
    });
    this.y -= 12;
  }

  space(h = 8): void {
    this.y -= h;
  }

  table(cols: PdfTableCol[], rows: string[][], opts: { totals?: string[]; zebra?: boolean } = {}): void {
    const size = 8.6;
    const rowH = 15;
    const drawRow = (cells: string[], bold: boolean, zebra: boolean): void => {
      this.ensure(rowH + 4);
      if (zebra) {
        this.page.drawRectangle({ x: this.margin - 2, y: this.y - rowH + 2.5, width: this.width + 4, height: rowH - 1, color: rgb(0.97, 0.975, 0.985) });
      }
      let x = this.margin;
      cols.forEach((c, i) => {
        const cw = c.w * this.width;
        const raw = cells[i] ?? '';
        const font = bold ? this.bold : this.font;
        let str = raw;
        while (str.length > 1 && font.widthOfTextAtSize(str, size) > cw - 6) str = str.slice(0, -1);
        if (str !== raw) str = str.slice(0, -1) + '…';
        const tx = c.align === 'right' ? x + cw - 4 - font.widthOfTextAtSize(str, size) : x;
        this.page.drawText(str, { x: tx, y: this.y - 11, size, font, color: INK });
        x += cw;
      });
      this.y -= rowH;
    };
    // header
    this.ensure(rowH + 6);
    let x = this.margin;
    cols.forEach((c) => {
      const cw = c.w * this.width;
      const tx = c.align === 'right' ? x + cw - 4 - this.bold.widthOfTextAtSize(c.label.toUpperCase(), 7.6) : x;
      this.page.drawText(c.label.toUpperCase(), { x: tx, y: this.y - 10, size: 7.6, font: this.bold, color: MUTED });
      x += cw;
    });
    this.y -= 14;
    this.hr();
    this.y += 6;
    rows.forEach((r, i) => drawRow(r, false, !!opts.zebra && i % 2 === 1));
    if (opts.totals) {
      this.hr();
      this.y += 6;
      drawRow(opts.totals, true, false);
    }
    this.y -= 4;
  }

  footerAllPages(note: string): void {
    const pages = this.doc.getPages();
    pages.forEach((pg, i) => {
      pg.drawText(`${note} — page ${i + 1} of ${pages.length}`, {
        x: this.margin, y: 26, size: 7.5, font: this.font, color: MUTED,
      });
    });
  }

  private wrap(str: string, width: number, size: number, font: PDFFont): string[] {
    const words = str.split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > width && cur) {
        lines.push(cur);
        cur = w;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  async bytes(): Promise<Uint8Array> {
    return this.doc.save();
  }
}
