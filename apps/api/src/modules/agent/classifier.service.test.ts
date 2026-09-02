/**
 * Stage-1 classifier tests.
 *
 * The behaviours worth pinning down here are the failure ones. A
 * classifier that misroutes a question is a bad answer; a classifier
 * that THROWS takes the whole chat offline, which is how the previous
 * incident (FakeLlm in production) presented. Every path through this
 * module must degrade to `pre_sales` rather than raise.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ClassifierService,
  extractJsonObject,
  normaliseClassification,
} from './classifier.service.js';
import type { OpenRouterService } from '../../integrations/openrouter/index.js';
import { SpendCapExceededError } from '../../integrations/openrouter/index.js';

/** Minimal OpenRouterService stand-in — only `complete` is exercised. */
function stubLlm(impl: () => Promise<unknown> | unknown): OpenRouterService {
  return { complete: vi.fn(impl) } as unknown as OpenRouterService;
}

function llmReturning(content: string) {
  return stubLlm(() => ({
    content,
    toolCalls: [],
    model: 'test-model',
    promptTokens: 10,
    completionTokens: 5,
    costMicroUsd: 42,
  }));
}

const PROMPT = 'classify the message';

// ============================================================
// extractJsonObject
// ============================================================

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"category":"pre_sales"}')).toEqual({ category: 'pre_sales' });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    const raw = '```json\n{"category":"complaint"}\n```';
    expect(extractJsonObject(raw)).toEqual({ category: 'complaint' });
  });

  it('parses JSON with prose either side', () => {
    const raw = 'Here you go:\n{"category":"order_status"}\nHope that helps!';
    expect(extractJsonObject(raw)).toEqual({ category: 'order_status' });
  });

  it('returns undefined for prose with no object', () => {
    expect(extractJsonObject('I think this is a sales question.')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(extractJsonObject('{"category": pre_sales}')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractJsonObject('')).toBeUndefined();
  });
});

// ============================================================
// normaliseClassification
// ============================================================

describe('normaliseClassification', () => {
  it('accepts a well-formed payload', () => {
    const out = normaliseClassification({
      category: 'delivery_returns',
      confidence: 'high',
      clarify_prompt: null,
      refusal_reason: null,
    });
    expect(out).toEqual({
      category: 'delivery_returns',
      confidence: 'high',
      clarifyPrompt: null,
      refusalReason: null,
    });
  });

  it('lower-cases and trims the category', () => {
    expect(normaliseClassification({ category: '  PRE_SALES  ' })?.category).toBe('pre_sales');
  });

  it('rejects an unknown category', () => {
    expect(normaliseClassification({ category: 'refund_maybe' })).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(normaliseClassification('pre_sales')).toBeNull();
    expect(normaliseClassification(null)).toBeNull();
    expect(normaliseClassification(42)).toBeNull();
  });

  it('defaults an invalid confidence to medium rather than failing', () => {
    expect(normaliseClassification({ category: 'pre_sales', confidence: 'very' })?.confidence)
      .toBe('medium');
  });

  it('keeps clarify_prompt only for ambiguous', () => {
    const ambiguous = normaliseClassification({
      category: 'ambiguous',
      clarify_prompt: 'Do you mean a return or a fault?',
    });
    expect(ambiguous?.clarifyPrompt).toBe('Do you mean a return or a fault?');

    const sales = normaliseClassification({
      category: 'pre_sales',
      clarify_prompt: 'stray value',
    });
    expect(sales?.clarifyPrompt).toBeNull();
  });

  it('downgrades ambiguous-with-no-question to pre_sales', () => {
    // Replying with an empty clarifying question would be worse than
    // just answering as a sales query.
    const out = normaliseClassification({ category: 'ambiguous', clarify_prompt: '  ' });
    expect(out?.category).toBe('pre_sales');
    expect(out?.clarifyPrompt).toBeNull();
  });

  it('keeps refusal_reason only for irrelevant, with a default', () => {
    expect(
      normaliseClassification({ category: 'irrelevant', refusal_reason: 'asked for code' })
        ?.refusalReason,
    ).toBe('asked for code');
    expect(normaliseClassification({ category: 'irrelevant' })?.refusalReason).toBe('off-topic');
    expect(
      normaliseClassification({ category: 'complaint', refusal_reason: 'stray' })?.refusalReason,
    ).toBeNull();
  });
});

// ============================================================
// ClassifierService.classify
// ============================================================

describe('ClassifierService.classify', () => {
  it('returns the model\'s classification on the happy path', async () => {
    const svc = new ClassifierService(
      llmReturning('{"category":"order_status","confidence":"high"}'),
    );
    const out = await svc.classify(PROMPT, 'where is my order');
    expect(out.category).toBe('order_status');
    expect(out.confidence).toBe('high');
    expect(out.degraded).toBe(false);
    expect(out.costMicroUsd).toBe(42);
  });

  it('degrades to pre_sales when the model throws', async () => {
    const svc = new ClassifierService(
      stubLlm(() => {
        throw new Error('upstream 500');
      }),
    );
    const out = await svc.classify(PROMPT, 'anything');
    expect(out.category).toBe('pre_sales');
    expect(out.degraded).toBe(true);
    expect(out.degradedReason).toBe('llm_error');
  });

  it('degrades to pre_sales on the spend cap rather than throwing', async () => {
    const svc = new ClassifierService(
      stubLlm(() => {
        throw new SpendCapExceededError(2_000_000, 2_000_000);
      }),
    );
    const out = await svc.classify(PROMPT, 'anything');
    expect(out.category).toBe('pre_sales');
    expect(out.degraded).toBe(true);
  });

  it('degrades to pre_sales when the model returns prose', async () => {
    const svc = new ClassifierService(llmReturning('This looks like a sales enquiry to me.'));
    const out = await svc.classify(PROMPT, 'anything');
    expect(out.category).toBe('pre_sales');
    expect(out.degradedReason).toBe('unparseable');
  });

  it('degrades to pre_sales when the model invents a category', async () => {
    const svc = new ClassifierService(llmReturning('{"category":"warranty_claim"}'));
    const out = await svc.classify(PROMPT, 'anything');
    expect(out.category).toBe('pre_sales');
    expect(out.degradedReason).toBe('unparseable');
  });

  it('degrades to pre_sales when the model returns null content', async () => {
    const svc = new ClassifierService(
      stubLlm(() => ({
        content: null,
        toolCalls: [],
        model: 'm',
        promptTokens: 0,
        completionTokens: 0,
        costMicroUsd: 0,
      })),
    );
    const out = await svc.classify(PROMPT, 'anything');
    expect(out.category).toBe('pre_sales');
    expect(out.degraded).toBe(true);
  });

  it('classifies an off-topic message as irrelevant', async () => {
    const svc = new ClassifierService(
      llmReturning('{"category":"irrelevant","confidence":"high","refusal_reason":"code request"}'),
    );
    const out = await svc.classify(PROMPT, 'write me a Python script');
    expect(out.category).toBe('irrelevant');
    expect(out.refusalReason).toBe('code request');
  });

  it('uses the configured cheap classifier model, not the chat model', async () => {
    const complete = vi.fn(() => ({
      content: '{"category":"pre_sales"}',
      toolCalls: [],
      model: 'm',
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
    }));
    const svc = new ClassifierService({ complete } as unknown as OpenRouterService);
    await svc.classify(PROMPT, 'hello');
    const arg = complete.mock.calls[0]![0] as { models?: string[]; tools?: unknown };
    expect(arg.models).toBeDefined();
    expect(arg.models!.length).toBeGreaterThan(0);
    // The classifier never needs tools — sending them would cost tokens
    // on every turn for nothing.
    expect(arg.tools).toBeUndefined();
  });

  it('sends only recent prose turns as history, never tool payloads', async () => {
    const complete = vi.fn(() => ({
      content: '{"category":"pre_sales"}',
      toolCalls: [],
      model: 'm',
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
    }));
    const svc = new ClassifierService({ complete } as unknown as OpenRouterService);
    await svc.classify(PROMPT, 'and in blue?', [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'tool', content: '{"huge":"tool payload"}', toolCallId: 'x', name: 'search' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'turn 3' },
      { role: 'assistant', content: 'reply 3' },
    ]);
    const arg = complete.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const roles = arg.messages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles).not.toContain('tool');
    // system + 4 history turns + the current message
    expect(arg.messages).toHaveLength(6);
    expect(arg.messages.at(-1)!.content).toBe('and in blue?');
  });

  it('drops empty-content history turns', async () => {
    const complete = vi.fn(() => ({
      content: '{"category":"pre_sales"}',
      toolCalls: [],
      model: 'm',
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
    }));
    const svc = new ClassifierService({ complete } as unknown as OpenRouterService);
    await svc.classify(PROMPT, 'hi', [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'real turn' },
    ]);
    const arg = complete.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(arg.messages).toHaveLength(3); // system + 'real turn' + current
  });

  it('records latency on both the success and the degraded path', async () => {
    const ok = new ClassifierService(llmReturning('{"category":"pre_sales"}'));
    expect((await ok.classify(PROMPT, 'x')).latencyMs).toBeGreaterThanOrEqual(0);

    const bad = new ClassifierService(
      stubLlm(() => {
        throw new Error('nope');
      }),
    );
    expect((await bad.classify(PROMPT, 'x')).latencyMs).toBeGreaterThanOrEqual(0);
  });
});
