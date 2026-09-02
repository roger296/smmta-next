/**
 * Stage 1 of the chat pipeline: decide what kind of question this is —
 * or that it isn't a question for this store at all.
 *
 * Runs on EVERY user turn, deliberately: customers pivot mid-conversation
 * ("where's my order? — oh, and do you stock brown PETG?"), and pinning a
 * session to its first classification would route the second question to
 * the wrong specialist. A small model and a ~300-token prompt make that
 * affordable.
 *
 * Two properties this module is built around:
 *
 *   - It NEVER throws for classification reasons. Any failure — model
 *     down, malformed JSON, unknown category, spend cap — degrades to
 *     `pre_sales` with low confidence, which is exactly how the chat
 *     behaved before a classifier existed. A broken classifier must not
 *     be able to take chat offline.
 *
 *   - The refusal copy for `irrelevant` is NOT generated here. It comes
 *     verbatim from chatbot_config.offtopic_refusal. A prompt injection
 *     that convinces the classifier a message is off-topic must not also
 *     get to write the refusal in the attacker's voice.
 */
import { getEnv } from '../../config/env.js';
import {
  OpenRouterService,
  SpendCapExceededError,
  type LlmMessage,
} from '../../integrations/openrouter/index.js';
import {
  CHAT_CATEGORIES,
  CHAT_NON_SPECIALIST_OUTCOMES,
  type ChatClassifierOutcome,
} from '../../db/schema/index.js';

const ALL_OUTCOMES: readonly string[] = [...CHAT_CATEGORIES, ...CHAT_NON_SPECIALIST_OUTCOMES];
const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type ChatConfidence = (typeof CONFIDENCES)[number];

/** How many prior turns the classifier sees. Enough to resolve pronouns
 *  ("is it in stock?") without paying to re-read a long conversation. */
const HISTORY_TURNS = 4;

export interface Classification {
  category: ChatClassifierOutcome;
  confidence: ChatConfidence;
  /** Present when category is 'ambiguous' — the question to ask back. */
  clarifyPrompt: string | null;
  /** Present when category is 'irrelevant' — internal note, never shown. */
  refusalReason: string | null;
  /** Diagnostics for chat_classifications + the admin test bench. */
  latencyMs: number;
  costMicroUsd: number;
  /** True when we fell back rather than genuinely classifying. */
  degraded: boolean;
  /** Why we fell back. Null on a real classification. Surfaced in the
   *  test bench so a prompt that stops producing JSON is obvious. */
  degradedReason: 'llm_error' | 'unparseable' | null;
}

/** The safe default: behave exactly as the pre-classifier chat did. */
function fallback(
  latencyMs: number,
  reason: 'llm_error' | 'unparseable',
): Classification {
  return {
    category: 'pre_sales',
    confidence: 'low',
    clarifyPrompt: null,
    refusalReason: null,
    latencyMs,
    costMicroUsd: 0,
    degraded: true,
    degradedReason: reason,
  };
}

/**
 * Pull the first JSON object out of a model response.
 *
 * Models wrap JSON in prose or a ```json fence often enough that
 * demanding a bare object would fail turns that actually classified
 * correctly. We take the outermost braces and parse that.
 */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Validate a parsed classifier payload without Zod — the shape is tiny
 * and every field has a defined degradation, so hand-checking keeps the
 * "never throw" guarantee obvious at the call site.
 */
export function normaliseClassification(
  parsed: unknown,
): Omit<
  Classification,
  'latencyMs' | 'costMicroUsd' | 'degraded' | 'degradedReason'
> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;

  const rawCategory = typeof o.category === 'string' ? o.category.trim().toLowerCase() : '';
  if (!ALL_OUTCOMES.includes(rawCategory)) return null;
  const category = rawCategory as ChatClassifierOutcome;

  const rawConfidence =
    typeof o.confidence === 'string' ? o.confidence.trim().toLowerCase() : '';
  const confidence = (CONFIDENCES as readonly string[]).includes(rawConfidence)
    ? (rawConfidence as ChatConfidence)
    : 'medium';

  const clarifyRaw = typeof o.clarify_prompt === 'string' ? o.clarify_prompt.trim() : '';
  const refusalRaw = typeof o.refusal_reason === 'string' ? o.refusal_reason.trim() : '';

  // An 'ambiguous' verdict with no question to ask back is useless —
  // treat it as pre_sales rather than replying with an empty clarifier.
  if (category === 'ambiguous' && !clarifyRaw) {
    return { category: 'pre_sales', confidence: 'low', clarifyPrompt: null, refusalReason: null };
  }

  return {
    category,
    confidence,
    clarifyPrompt: category === 'ambiguous' ? clarifyRaw : null,
    refusalReason: category === 'irrelevant' ? refusalRaw || 'off-topic' : null,
  };
}

export class ClassifierService {
  private llm: OpenRouterService;

  constructor(llm?: OpenRouterService) {
    this.llm = llm ?? new OpenRouterService();
  }

  /**
   * Classify one user turn. `systemPrompt` is the already-rendered
   * classifier prompt from chatbot_config (placeholders substituted).
   * `history` is the conversation so far, oldest first.
   */
  async classify(
    systemPrompt: string,
    userText: string,
    history: LlmMessage[] = [],
  ): Promise<Classification> {
    const started = Date.now();
    const env = getEnv();

    // Only the tail of the conversation, and only the prose turns —
    // tool-call payloads are noise for a classifier and can be large.
    const recent = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-HISTORY_TURNS);

    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...recent,
      { role: 'user', content: userText },
    ];

    let result;
    try {
      result = await this.llm.complete({
        messages,
        purpose: 'other',
        models: [env.OPENROUTER_CLASSIFIER_MODEL],
      });
    } catch (err) {
      // Spend cap and model failures both degrade to the safe default.
      // The caller logs; chat continues.
      void (err instanceof SpendCapExceededError);
      return fallback(Date.now() - started, 'llm_error');
    }

    const parsed = extractJsonObject(result.content ?? '');
    const normalised = normaliseClassification(parsed);
    if (!normalised) return fallback(Date.now() - started, 'unparseable');

    return {
      ...normalised,
      latencyMs: Date.now() - started,
      costMicroUsd: result.costMicroUsd,
      degraded: false,
      degradedReason: null,
    };
  }
}
