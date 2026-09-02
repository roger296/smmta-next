/**
 * Splits a knowledge-base markdown document into retrievable chunks.
 *
 * Chunking strategy: split on headings, then split any oversized
 * section on paragraph boundaries. Headings are the natural unit here —
 * a hand-written FAQ is already one question per heading, and keeping a
 * question with its whole answer means retrieval returns something the
 * specialist can quote directly rather than a fragment it has to guess
 * around.
 *
 * Deliberately not a general markdown parser. It handles ATX headings
 * (`## Question`) and paragraphs; everything else (lists, code, tables,
 * links) passes through as body text, which is what we want — the
 * specialist reads it as prose and the search vector indexes the words.
 */

/** Soft cap per chunk. Not tokens — characters, which is all we need to
 *  keep a retrieved chunk small enough to sit comfortably in a prompt
 *  alongside two others. Roughly 350-500 tokens of English. */
const MAX_CHUNK_CHARS = 1600;

/** Below this, a trailing split is folded back into the previous chunk
 *  rather than left as an orphan fragment. */
const MIN_TAIL_CHARS = 200;

export interface KbChunk {
  ordinal: number;
  heading: string;
  body: string;
}

interface Section {
  heading: string;
  lines: string[];
}

/** Match an ATX heading and capture its text. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Split markdown into (heading, body) sections.
 *
 * Content before the first heading is kept under an empty heading
 * rather than dropped — a document that opens with a paragraph of
 * context shouldn't lose it.
 */
export function splitIntoSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: '', lines: [] };

  for (const line of markdown.split(/\r?\n/)) {
    const match = HEADING_RE.exec(line);
    if (match) {
      // Close the open section if it has any content or a heading.
      if (current.heading || current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: match[2]!.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading || current.lines.some((l) => l.trim())) sections.push(current);
  return sections;
}

/**
 * Break an oversized body on paragraph boundaries, keeping each piece
 * under the cap where possible. A single paragraph longer than the cap
 * is emitted whole rather than cut mid-sentence — a truncated sentence
 * retrieves badly and reads worse when quoted.
 */
export function splitOversizedBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];

  const paragraphs = body.split(/\n{2,}/).filter((p) => p.trim());
  const out: string[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (!buffer) {
      buffer = para;
      continue;
    }
    if (buffer.length + para.length + 2 <= MAX_CHUNK_CHARS) {
      buffer = `${buffer}\n\n${para}`;
    } else {
      out.push(buffer);
      buffer = para;
    }
  }
  if (buffer) {
    // Fold a very short tail back into the previous chunk instead of
    // leaving a fragment that retrieves without enough context to be
    // usable.
    if (out.length > 0 && buffer.length < MIN_TAIL_CHARS) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${buffer}`;
    } else {
      out.push(buffer);
    }
  }
  return out;
}

/**
 * Chunk a whole document. Sections with no body text are dropped — a
 * bare heading indexes nothing useful and would dilute search results.
 * When a section splits, every piece keeps the section's heading so the
 * retrieved chunk still says what it's about.
 */
export function chunkMarkdown(markdown: string): KbChunk[] {
  const chunks: KbChunk[] = [];
  let ordinal = 0;

  for (const section of splitIntoSections(markdown)) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;
    for (const piece of splitOversizedBody(body)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      chunks.push({ ordinal: ordinal++, heading: section.heading, body: trimmed });
    }
  }
  return chunks;
}
