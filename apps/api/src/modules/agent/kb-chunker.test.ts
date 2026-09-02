/**
 * Chunker tests.
 *
 * The chunker decides what the delivery/returns and product-advice
 * specialists are able to retrieve. A section that gets dropped is an
 * answer the assistant will claim not to know; a section that gets cut
 * mid-sentence is an answer it will quote wrongly. Both failures are
 * silent at write time and only show up as a bad reply weeks later,
 * which is why this is tested harder than its size suggests.
 */
import { describe, expect, it } from 'vitest';
import { chunkMarkdown, splitIntoSections, splitOversizedBody } from './kb-chunker.js';

describe('splitIntoSections', () => {
  it('splits on ATX headings', () => {
    const out = splitIntoSections('## One\nbody one\n\n## Two\nbody two');
    expect(out).toHaveLength(2);
    expect(out[0]!.heading).toBe('One');
    expect(out[1]!.heading).toBe('Two');
  });

  it('handles every heading level', () => {
    const out = splitIntoSections('# H1\na\n## H2\nb\n###### H6\nc');
    expect(out.map((s) => s.heading)).toEqual(['H1', 'H2', 'H6']);
  });

  it('keeps content that appears before the first heading', () => {
    // A document opening with a paragraph of context shouldn't lose it.
    const out = splitIntoSections('Intro paragraph.\n\n## First\nbody');
    expect(out).toHaveLength(2);
    expect(out[0]!.heading).toBe('');
    expect(out[0]!.lines.join('\n')).toContain('Intro paragraph.');
  });

  it('returns nothing for an empty document', () => {
    expect(splitIntoSections('')).toEqual([]);
    expect(splitIntoSections('\n\n   \n')).toEqual([]);
  });

  it('does not treat a hash inside text as a heading', () => {
    const out = splitIntoSections('## Real\nuse #3 nozzle\nnot #a heading');
    expect(out).toHaveLength(1);
    expect(out[0]!.lines.join('\n')).toContain('#3 nozzle');
  });

  it('keeps a heading with no body as its own section', () => {
    const out = splitIntoSections('## Empty\n\n## Full\nbody');
    expect(out.map((s) => s.heading)).toEqual(['Empty', 'Full']);
  });
});

describe('splitOversizedBody', () => {
  it('leaves a short body alone', () => {
    expect(splitOversizedBody('short')).toEqual(['short']);
  });

  it('splits a long body on paragraph boundaries', () => {
    const para = 'x'.repeat(700);
    const out = splitOversizedBody([para, para, para].join('\n\n'));
    expect(out.length).toBeGreaterThan(1);
    // Nothing should be cut mid-paragraph.
    for (const chunk of out) {
      expect(chunk.replace(/\n/g, '')).toMatch(/^x+$/);
    }
  });

  it('emits an over-long single paragraph whole rather than cutting a sentence', () => {
    const giant = 'y'.repeat(5000);
    expect(splitOversizedBody(giant)).toEqual([giant]);
  });

  it('folds a short tail back into the previous chunk', () => {
    const big = 'z'.repeat(1500);
    const tail = 'a short trailing note';
    const out = splitOversizedBody(`${big}\n\n${big}\n\n${tail}`);
    expect(out.at(-1)).toContain(tail);
    // The tail should be attached to real content, not standing alone.
    expect(out.at(-1)!.length).toBeGreaterThan(tail.length);
  });
});

describe('chunkMarkdown', () => {
  const FAQ = `## How long does delivery take?

Orders before 2pm ship same day.

## What is your returns policy?

28 days, sealed only.

## Do you ship to the EU?

Yes, duties payable on arrival.`;

  it('produces one chunk per FAQ question', () => {
    const out = chunkMarkdown(FAQ);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.heading)).toEqual([
      'How long does delivery take?',
      'What is your returns policy?',
      'Do you ship to the EU?',
    ]);
  });

  it('numbers chunks sequentially from zero', () => {
    const out = chunkMarkdown(FAQ);
    expect(out.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('keeps the answer as the body', () => {
    const out = chunkMarkdown(FAQ);
    expect(out[0]!.body).toBe('Orders before 2pm ship same day.');
  });

  it('drops heading-only sections that would index nothing', () => {
    const out = chunkMarkdown('## Has body\ntext\n\n## No body\n\n## Also has body\nmore');
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.heading)).toEqual(['Has body', 'Also has body']);
  });

  it('repeats the heading on every piece of a split section', () => {
    // A retrieved fragment must still say what it is about.
    const para = 'w'.repeat(800);
    const out = chunkMarkdown(`## Long section\n${para}\n\n${para}\n\n${para}`);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.heading).toBe('Long section');
    }
  });

  it('keeps ordinals unique across a split section', () => {
    const para = 'w'.repeat(800);
    const out = chunkMarkdown(`## A\n${para}\n\n${para}\n\n${para}\n\n## B\nshort`);
    const ordinals = out.map((c) => c.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });

  it('returns nothing for an empty document', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n\n  ')).toEqual([]);
  });

  it('preserves list and link markup as body text', () => {
    // Not parsed — the specialist reads it as prose and the search
    // vector indexes the words either way.
    const out = chunkMarkdown(
      '## Materials\n- PLA for prototyping\n- PETG for functional parts\n\nSee [our guide](/guide).',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain('- PLA for prototyping');
    expect(out[0]!.body).toContain('[our guide](/guide)');
  });

  it('handles a document with no headings at all', () => {
    const out = chunkMarkdown('Just a paragraph of policy text with no heading.');
    expect(out).toHaveLength(1);
    expect(out[0]!.heading).toBe('');
    expect(out[0]!.body).toContain('Just a paragraph');
  });

  it('is stable — chunking the same input twice gives the same output', () => {
    expect(chunkMarkdown(FAQ)).toEqual(chunkMarkdown(FAQ));
  });
});
