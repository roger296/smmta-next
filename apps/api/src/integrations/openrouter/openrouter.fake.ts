/**
 * Scripted OpenRouter fake for tests (SPEC testing discipline). Enqueue the
 * results the "model" should return, in order; each `complete` pops the next.
 * Deterministic tool-call ids.
 */
import type { CompleteInput, LlmPort, LlmResult, LlmToolCall } from './openrouter.types.js';

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  costMicroUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export class FakeLlm implements LlmPort {
  private script: ScriptedTurn[] = [];
  private seq = 0;
  public calls: CompleteInput[] = [];

  enqueue(...turns: ScriptedTurn[]): this {
    this.script.push(...turns);
    return this;
  }

  reset(): void {
    this.script = [];
    this.calls = [];
    this.seq = 0;
  }

  async complete(input: CompleteInput): Promise<LlmResult> {
    this.calls.push(input);
    const turn = this.script.shift();
    if (!turn) throw new Error('FakeLlm: no scripted turn left');
    const toolCalls: LlmToolCall[] = (turn.toolCalls ?? []).map((t) => {
      this.seq += 1;
      return { id: `call_${this.seq}`, name: t.name, arguments: t.arguments };
    });
    return {
      content: turn.content ?? null,
      toolCalls,
      model: input.model,
      promptTokens: turn.promptTokens ?? 100,
      completionTokens: turn.completionTokens ?? 50,
      costMicroUsd: turn.costMicroUsd ?? 500, // $0.0005 default
    };
  }
}
