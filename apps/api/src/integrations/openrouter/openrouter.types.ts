/**
 * OpenRouter wrapper types (SPEC §4.5). Tool-calling chat completions behind a
 * port so tests inject a scripted fake. Cost is integer MICRO-USD everywhere
 * (the per-day cap sums it) — no floats near money.
 */
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  toolCalls?: LlmToolCall[];
  toolCallId?: string; // for role='tool'
  name?: string; // tool name for role='tool'
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LlmResult {
  content: string | null;
  toolCalls: LlmToolCall[];
  model: string;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
}

export interface CompleteInput {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
}

/** The raw transport (real client or fake). */
export interface LlmPort {
  complete(input: CompleteInput): Promise<LlmResult>;
}
