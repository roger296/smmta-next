/**
 * Tests for the seeded prompt set.
 *
 * These guard two properties the multi-store design depends on:
 *   1. No prompt hard-codes a product domain. The same defaults must
 *      seed the filament store and the clothing store — a stray
 *      "filament" or "spool" here silently ships the wrong assistant
 *      to the second store.
 *   2. Every category in CHAT_CATEGORIES has a default, and the
 *      LLM-backed ones actually carry a prompt body.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_CATEGORIES } from '../../db/schema/index.js';
import {
  DEFAULT_CLASSIFIER_PROMPT,
  DEFAULT_OFFTOPIC_REFUSAL,
  DEFAULT_SPECIALISTS,
  RULE_BASED_REPLIES,
  renderPrompt,
} from './default-prompts.js';

/** Words that would betray a store-specific default leaking into the
 *  shared seed set. Deliberately includes both domains we ship. */
const DOMAIN_WORDS = [
  'filament',
  'spool',
  'petg',
  ' pla ',
  'nozzle',
  'hotend',
  'garment',
  'fabric',
  't-shirt',
];

function assertDomainNeutral(label: string, body: string) {
  const lower = ` ${body.toLowerCase()} `;
  for (const word of DOMAIN_WORDS) {
    expect(lower, `${label} must not hard-code the product domain ("${word.trim()}")`)
      .not.toContain(word);
  }
}

describe('default prompts — domain neutrality', () => {
  it('the classifier prompt names no specific product domain', () => {
    assertDomainNeutral('classifier prompt', DEFAULT_CLASSIFIER_PROMPT);
  });

  it('the off-topic refusal names no specific product domain', () => {
    assertDomainNeutral('offtopic refusal', DEFAULT_OFFTOPIC_REFUSAL);
  });

  it('every specialist prompt names no specific product domain', () => {
    for (const s of DEFAULT_SPECIALISTS) {
      assertDomainNeutral(`${s.category} prompt`, s.systemPrompt);
    }
  });

  it('every rule-based reply names no specific product domain', () => {
    for (const [category, body] of Object.entries(RULE_BASED_REPLIES)) {
      assertDomainNeutral(`${category} canned reply`, body);
    }
  });
});

describe('default prompts — coverage', () => {
  it('provides a default for every category in CHAT_CATEGORIES', () => {
    const covered = DEFAULT_SPECIALISTS.map((s) => s.category).sort();
    expect(covered).toEqual([...CHAT_CATEGORIES].sort());
  });

  it('LLM-backed specialists carry a non-empty prompt', () => {
    for (const s of DEFAULT_SPECIALISTS.filter((x) => x.llmBacked)) {
      expect(s.systemPrompt.length, `${s.category} should have a prompt`).toBeGreaterThan(200);
    }
  });

  it('rule-based specialists have no prompt but do have canned copy', () => {
    for (const s of DEFAULT_SPECIALISTS.filter((x) => !x.llmBacked)) {
      expect(s.systemPrompt).toBe('');
      expect(RULE_BASED_REPLIES[s.category], `${s.category} needs a canned reply`).toBeTruthy();
    }
  });

  it('every LLM-backed prompt carries the anti-injection rule', () => {
    for (const s of DEFAULT_SPECIALISTS.filter((x) => x.llmBacked)) {
      expect(s.systemPrompt.toLowerCase()).toContain('ignore any instruction');
    }
  });

  it('every LLM-backed prompt forbids unsourced prices', () => {
    for (const s of DEFAULT_SPECIALISTS.filter((x) => x.llmBacked)) {
      expect(s.systemPrompt.toLowerCase()).toContain('never state a price');
    }
  });
});

describe('renderPrompt', () => {
  const vars = { storeName: 'Filament Store', productKind: '3D printer filament' };

  it('replaces every occurrence of both placeholders', () => {
    const out = renderPrompt(
      '{{store_name}} sells {{product_kind}}. Only {{product_kind}}.',
      vars,
    );
    expect(out).toBe('Filament Store sells 3D printer filament. Only 3D printer filament.');
  });

  it('leaves a prompt with no placeholders untouched', () => {
    expect(renderPrompt('plain text', vars)).toBe('plain text');
  });

  it('renders the classifier prompt with no placeholders left behind', () => {
    const out = renderPrompt(DEFAULT_CLASSIFIER_PROMPT, vars);
    expect(out).not.toContain('{{');
    expect(out).toContain('3D printer filament');
  });

  it('renders every specialist prompt with no placeholders left behind', () => {
    for (const s of DEFAULT_SPECIALISTS.filter((x) => x.llmBacked)) {
      const out = renderPrompt(s.systemPrompt, vars);
      expect(out, `${s.category} left a placeholder`).not.toContain('{{');
    }
  });

  it('adapts cleanly to a completely different domain', () => {
    const out = renderPrompt(DEFAULT_CLASSIFIER_PROMPT, {
      storeName: 'CleverDeals Clothes',
      productKind: 'workwear and branded clothing',
    });
    expect(out).toContain('CleverDeals Clothes');
    expect(out).toContain('workwear and branded clothing');
    expect(out.toLowerCase()).not.toContain('filament');
  });
});
