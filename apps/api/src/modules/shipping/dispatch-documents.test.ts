import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { combinePdfs } from './dispatch-documents.js';

async function pdfWithPages(sizes: Array<[number, number]>): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  return Buffer.from(await doc.save());
}

describe('combinePdfs', () => {
  it('puts every page of each document into one file, in order, keeping page sizes', async () => {
    const pickNote = await pdfWithPages([[288, 288], [288, 288]]);
    const label = await pdfWithPages([[288, 432]]);
    const combined = await PDFDocument.load(await combinePdfs([pickNote, label]));

    expect(combined.getPageCount()).toBe(3);
    expect(combined.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [288, 288],
      [288, 288],
      [288, 432],
    ]);
  });
});
