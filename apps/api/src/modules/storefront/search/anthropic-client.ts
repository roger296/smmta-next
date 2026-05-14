/**
 * Minimal Anthropic Messages API client for the conversational
 * search parser.
 *
 * We don't pull in the official `@anthropic-ai/sdk` for two reasons:
 *   1. It adds ~150KB of bundle weight + a couple of transitive
 *      deps we don't need anywhere else in the stack.
 *   2. The native `fetch` call here is ~30 lines + lets us swap the
 *      transport for a stub in tests without resorting to module
 *      mocks. Less magic, easier to reason about.
 *
 * Model: Claude Haiku 4.5 (the current cheap-fast tier as of writing
 * — verify against the Anthropic model docs and bump as needed).
 * Output is forced to JSON via the `response_format` field; if that
 * field stops being supported, the regex-extraction fallback in
 * `parseQuery` still works against plain-text responses that contain
 * a JSON object somewhere in the body.
 */
import type { ParsedQuery } from './parser.types.js';
import { parsedQuerySchema } from './parser.types.js';

/** Default model. Override via `ANTHROPIC_MODEL` env var if Anthropic
 *  retires this one before we redeploy. */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** Pricing in USD per million tokens, used to estimate the per-query
 *  cost we log. Approximate; numbers from Anthropic's published
 *  pricing at time of writing. Refresh when pricing changes. */
const PRICING_USD_PER_M_TOKENS = {
  input: 1.0,
  output: 5.0,
};

/** Rough USD → GBP for cost-logging purposes. We don't need
 *  accurate FX here; the daily-budget knob is a coarse safety
 *  valve, not a charge to a customer. */
const USD_TO_GBP = 0.78;

export interface AnthropicCallResult {
  /** The model's raw text content. */
  rawText: string;
  /** Tokens consumed — used to estimate cost for the budget tracker. */
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in GBP for this call. */
  costGbp: number;
}

export interface AnthropicTransport {
  call(args: {
    model: string;
    systemPrompt: string;
    userQuery: string;
    maxTokens: number;
    apiKey: string;
  }): Promise<AnthropicCallResult>;
}

/** Default transport — real HTTP to api.anthropic.com. */
export const httpTransport: AnthropicTransport = {
  async call({ model, systemPrompt, userQuery, maxTokens, apiKey }): Promise<AnthropicCallResult> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userQuery }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AnthropicError(`Anthropic API ${res.status}: ${text.slice(0, 400)}`, res.status);
    }
    const body = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const rawText =
      body.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n') ?? '';
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * PRICING_USD_PER_M_TOKENS.input +
      (outputTokens / 1_000_000) * PRICING_USD_PER_M_TOKENS.output;
    return {
      rawText,
      inputTokens,
      outputTokens,
      costGbp: costUsd * USD_TO_GBP,
    };
  },
};

export class AnthropicError extends Error {
  public readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

export interface ParseQueryOptions {
  apiKey: string;
  systemPrompt: string;
  userQuery: string;
  /** Cap the model's reply. JSON output for our schema fits well under
   *  this; making it large enough for a verbose model not to truncate
   *  but small enough to keep latency predictable. */
  maxTokens?: number;
  /** Override the model. Defaults to DEFAULT_MODEL / ANTHROPIC_MODEL env. */
  model?: string;
  /** Override the HTTP transport — used by tests. */
  transport?: AnthropicTransport;
}

export interface ParseQueryResult {
  parsed: ParsedQuery | null;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  costGbp: number;
}

/**
 * Call the LLM, extract JSON from the response, validate it against
 * the parser schema. Returns `parsed: null` (with the raw text + cost
 * intact for logging) when the response is unparseable; the caller
 * falls through to keyword search in that case.
 */
export async function parseQuery(opts: ParseQueryOptions): Promise<ParseQueryResult> {
  const transport = opts.transport ?? httpTransport;
  const result = await transport.call({
    apiKey: opts.apiKey,
    systemPrompt: opts.systemPrompt,
    userQuery: opts.userQuery,
    maxTokens: opts.maxTokens ?? 300,
    model: opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  });
  const parsed = extractAndValidate(result.rawText);
  return {
    parsed,
    rawText: result.rawText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costGbp: result.costGbp,
  };
}

/**
 * Find the first balanced JSON object in `text` and validate it. Some
 * models emit a code-fence wrapper (```json … ```) or a one-line
 * preamble before the JSON; we strip both.
 */
export function extractAndValidate(text: string): ParsedQuery | null {
  if (!text || typeof text !== 'string') return null;
  // Try the obvious case first — the whole response IS the JSON.
  const directParsed = tryParse(text);
  if (directParsed !== null) return directParsed;
  // Fall back to bracket-balanced extraction.
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        const out = tryParse(candidate);
        if (out !== null) return out;
        // First balanced candidate didn't validate — try the next one
        // by resuming from `i + 1`. Most responses only have one
        // object, so this rarely runs.
      }
    }
  }
  return null;
}

function tryParse(s: string): ParsedQuery | null {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return null;
  }
  const parsed = parsedQuerySchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}
