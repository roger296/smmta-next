/**
 * Combines PDFs into one document, keeping each page's own size.
 *
 * Used to put an order's pick note and shipping label into a single file so
 * the dispatcher prints both in one go. The label comes from Smooth Parcel and
 * may be a different size from the pick note; pages are copied, not redrawn,
 * so each keeps its size and nothing on the label is altered.
 */
import { PDFDocument } from 'pdf-lib';

export async function combinePdfs(parts: Buffer[]): Promise<Buffer> {
  const combined = await PDFDocument.create();
  for (const part of parts) {
    const source = await PDFDocument.load(part, { ignoreEncryption: true });
    const pages = await combined.copyPages(source, source.getPageIndices());
    for (const page of pages) combined.addPage(page);
  }
  return Buffer.from(await combined.save());
}
