/**
 * Real OpenRouter HTTP client (OpenAI-compatible chat/completions with tool
 * calling). BLOCKED until OPENROUTER_API_KEY is supplied; never run in tests
 * (the fake is injected). Cost is derived from the response usage where
 * available, else estimated as 0 (the wrapper still logs the row).
 */
import { getEnv } from '../../config/env.js';
import type { CompleteInput, LlmPort, LlmResult, LlmToolCall } from './openrouter.types.js';

interface OpenRouterChoice {
  message: {
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
}
interface OpenRouterResponse {
  model: string;
  choices: OpenRouterChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
}

export class OpenRouterClient implements LlmPort {
  private apiKey: string;
  private base = 'https://openrouter.ai/api/v1';

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? getEnv().OPENROUTER_API_KEY;
    if (!this.apiKey) throw new Error('OpenRouterClient: OPENROUTER_API_KEY not set (BLOCKED)');
  }

  async complete(input: CompleteInput): Promise<LlmResult> {
    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages.map((m) => ({
          role: m.role,
          content: m.content,
          tool_call_id: m.toolCallId,
          name: m.name,
          tool_calls: m.toolCalls?.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        })),
        tools: input.tools?.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    });
    const json = (await res.json()) as OpenRouterResponse & { error?: { message: string } };
    if (!res.ok) throw new Error(`OpenRouter failed: ${json.error?.message ?? res.status}`);

    const choice = json.choices[0];
    const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? []).map((t) => ({
      id: t.id,
      name: t.function.name,
      arguments: safeParse(t.function.arguments),
    }));
    return {
      content: choice?.message.content ?? null,
      toolCalls,
      model: json.model,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      costMicroUsd: json.usage?.cost != null ? Math.round(json.usage.cost * 1_000_000) : 0,
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
