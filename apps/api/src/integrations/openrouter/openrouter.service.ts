/**
 * OpenRouter wrapper service (SPEC §4.5). The single module api + worker use:
 *  - model from config with a fallback list (provider outage degrades, not
 *    breaks);
 *  - a per-DAY spend cap enforced by summing llm_log.cost_micro_usd (refuse over
 *    cap with a typed error);
 *  - every request/response logged to llm_log (audit + future tuning dataset).
 */
import { and, gte, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { llmLog } from '../../db/schema/index.js';
import type { LlmMessage, LlmPort, LlmResult, LlmToolDef } from './openrouter.types.js';
import { OpenRouterClient } from './openrouter.client.js';
import { FakeLlm } from './openrouter.fake.js';

export type LlmPurpose = 'chat' | 'compose' | 'other';

export class SpendCapExceededError extends Error {
  constructor(public readonly spentMicroUsd: number, public readonly capMicroUsd: number) {
    super(`OpenRouter daily spend cap reached: ${spentMicroUsd} ≥ ${capMicroUsd} micro-USD`);
    this.name = 'SpendCapExceededError';
  }
}

/** Thrown when a completion is attempted with no OPENROUTER_API_KEY set
 *  outside tests. Typed so the chat route can tell the customer the
 *  assistant is offline rather than emitting a generic 'internal'. */
export class LlmUnavailableError extends Error {
  constructor() {
    super('OPENROUTER_API_KEY is not set — the agent has no model to call');
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Stand-in port used when the API key is missing outside tests.
 *
 * Previously `getLlmPort()` fell back to `FakeLlm` whenever the key was
 * empty, INCLUDING in production. FakeLlm only answers from a script
 * that tests enqueue, so in production its very first call threw
 * "FakeLlm: no scripted turn left" — which surfaced to customers as a
 * bare {"error":"internal"} on every single chat message while session
 * creation kept working. Failing with a typed error here makes the
 * misconfiguration legible instead of masquerading as a bug.
 */
class UnconfiguredLlm implements LlmPort {
  async complete(): Promise<never> {
    throw new LlmUnavailableError();
  }
}

let _port: LlmPort | undefined;

export function getLlmPort(): LlmPort {
  if (!_port) {
    const env = getEnv();
    if (env.NODE_ENV === 'test') {
      _port = new FakeLlm();
    } else if (!env.OPENROUTER_API_KEY) {
      // Deliberately NOT FakeLlm — see UnconfiguredLlm's docstring.
      _port = new UnconfiguredLlm();
    } else {
      _port = new OpenRouterClient(env.OPENROUTER_API_KEY);
    }
  }
  return _port;
}

/** True when the agent has a real model configured. Used by the
 *  health endpoint + boot log so a missing key is visible before a
 *  customer finds it. */
export function isLlmConfigured(): boolean {
  const env = getEnv();
  return env.NODE_ENV === 'test' || Boolean(env.OPENROUTER_API_KEY);
}
export function setLlmPortForTests(port: LlmPort): void {
  _port = port;
}
export function resetLlmPortForTests(): void {
  _port = undefined;
}

export interface CompleteRequest {
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  purpose: LlmPurpose;
  /**
   * Try these models instead of the configured default + fallbacks.
   * Used by the stage-1 classifier, which wants the cheapest model that
   * can emit small JSON rather than the model that answers the turn.
   * Still walked in order with the same fallback behaviour.
   */
  models?: string[];
}

export class OpenRouterService {
  private db = getDb();
  private port: LlmPort;

  constructor(port?: LlmPort) {
    this.port = port ?? getLlmPort();
  }

  /** Sum of today's (UTC) logged cost in micro-USD. */
  async todaySpendMicroUsd(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${llmLog.costMicroUsd}), 0)::bigint` })
      .from(llmLog)
      .where(and(gte(llmLog.createdAt, startOfDay)));
    return Number(row?.total ?? 0);
  }

  private models(): string[] {
    const env = getEnv();
    const fallbacks = env.OPENROUTER_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
    return [env.OPENROUTER_MODEL, ...fallbacks];
  }

  async complete(req: CompleteRequest): Promise<LlmResult> {
    const cap = getEnv().OPENROUTER_DAILY_CAP_MICROUSD;
    const spent = await this.todaySpendMicroUsd();
    if (spent >= cap) throw new SpendCapExceededError(spent, cap);

    let result: LlmResult | undefined;
    let lastErr: unknown;
    const started = Date.now();
    const candidates = req.models?.length ? req.models : this.models();
    for (const model of candidates) {
      try {
        result = await this.port.complete({ model, messages: req.messages, tools: req.tools });
        break;
      } catch (err) {
        // A missing API key fails identically for every model in the
        // list — walking the fallbacks just burns time before throwing
        // the same error, so surface it immediately.
        if (err instanceof LlmUnavailableError) throw err;
        lastErr = err; // try the next fallback
      }
    }
    if (!result) throw lastErr ?? new Error('OpenRouter: all models failed');

    await this.db.insert(llmLog).values({
      companyId: getEnv().COMPANY_ID,
      purpose: req.purpose,
      model: result.model,
      requestJson: { messages: req.messages, tools: req.tools?.map((t) => t.name) },
      responseJson: { content: result.content, toolCalls: result.toolCalls },
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: Date.now() - started,
      costMicroUsd: result.costMicroUsd,
    });

    return result;
  }
}
