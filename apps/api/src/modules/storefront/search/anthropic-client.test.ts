/**
 * Unit tests for the LLM client + JSON extraction.
 *
 * No live Anthropic calls — every test stubs the transport.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type AnthropicTransport,
  extractAndValidate,
  parseQuery,
} from './anthropic-client.js';

const SAMPLE_JSON = `{
  "interpretation": "Searching for navy fleeces in size L",
  "categorySlug": "outerwear/fleeces",
  "keywords": ["outdoor"],
  "filters": {"colour": ["Navy"], "size": ["L"], "priceMax": 40},
  "sort": "relevance",
  "confidence": "high"
}`;

function stubTransport(rawText: string, usage = { input: 100, output: 50 }): AnthropicTransport {
  return {
    call: vi.fn(async () => ({
      rawText,
      inputTokens: usage.input,
      outputTokens: usage.output,
      // Tiny: 100 input @ $1/M = $0.0001 + 50 output @ $5/M = $0.00025 → $0.00035 × 0.78 = ~£0.000273
      costGbp: 0.000273,
    })),
  };
}

describe('extractAndValidate', () => {
  it('parses + validates a clean JSON response', () => {
    const out = extractAndValidate(SAMPLE_JSON);
    expect(out).not.toBeNull();
    expect(out!.categorySlug).toBe('outerwear/fleeces');
    expect(out!.filters.colour).toEqual(['Navy']);
    expect(out!.confidence).toBe('high');
  });

  it('extracts JSON from a code-fence-wrapped response', () => {
    const wrapped = '```json\n' + SAMPLE_JSON + '\n```';
    const out = extractAndValidate(wrapped);
    expect(out).not.toBeNull();
    expect(out!.categorySlug).toBe('outerwear/fleeces');
  });

  it('extracts JSON when the model emits a preamble', () => {
    const wrapped = 'Sure, here is the parsed query:\n' + SAMPLE_JSON;
    const out = extractAndValidate(wrapped);
    expect(out).not.toBeNull();
  });

  it('returns null for completely unparseable input', () => {
    expect(extractAndValidate('not json at all')).toBeNull();
    expect(extractAndValidate('')).toBeNull();
  });

  it('returns null when JSON is structurally valid but fails schema validation', () => {
    // Missing required `interpretation` field.
    expect(extractAndValidate('{"categorySlug":"tops/t-shirts"}')).toBeNull();
    // Wrong type for confidence.
    expect(
      extractAndValidate(
        '{"interpretation":"x","keywords":[],"filters":{},"confidence":"super-high"}',
      ),
    ).toBeNull();
  });

  it('accepts the minimum valid shape (interpretation + confidence only)', () => {
    const minimal = JSON.stringify({ interpretation: 'x', confidence: 'low' });
    const out = extractAndValidate(minimal);
    expect(out).not.toBeNull();
    expect(out!.confidence).toBe('low');
    // Default filters / keywords applied by the schema.
    expect(out!.keywords).toEqual([]);
    expect(out!.filters).toEqual({});
  });

  it('rejects extra fields not in the schema (strict mode)', () => {
    const withExtra = JSON.stringify({
      interpretation: 'x',
      confidence: 'high',
      keywords: [],
      filters: {},
      surprise: 'extra',
    });
    expect(extractAndValidate(withExtra)).toBeNull();
  });
});

describe('parseQuery (transport stub)', () => {
  it('returns the validated ParsedQuery + token counts + cost', async () => {
    const transport = stubTransport(SAMPLE_JSON);
    const result = await parseQuery({
      apiKey: 'sk-fake',
      systemPrompt: 'pretend prompt',
      userQuery: 'navy fleece large under £40',
      transport,
    });
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.categorySlug).toBe('outerwear/fleeces');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.costGbp).toBeGreaterThan(0);
    expect(result.costGbp).toBeLessThan(0.001);
  });

  it('parsed=null when the LLM emits unparseable text — still returns cost for logging', async () => {
    const transport = stubTransport('I cannot parse this query.');
    const result = await parseQuery({
      apiKey: 'sk-fake',
      systemPrompt: 'x',
      userQuery: 'mystery',
      transport,
    });
    expect(result.parsed).toBeNull();
    expect(result.rawText).toContain('cannot parse');
    expect(result.inputTokens).toBe(100);
  });

  it('passes through model + maxTokens overrides to the transport', async () => {
    const transport = stubTransport(SAMPLE_JSON);
    await parseQuery({
      apiKey: 'sk-fake',
      systemPrompt: 'x',
      userQuery: 'x',
      model: 'claude-opus-4-5-20251201',
      maxTokens: 500,
      transport,
    });
    expect(transport.call).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-5-20251201', maxTokens: 500 }),
    );
  });
});
