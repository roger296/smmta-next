/**
 * Sales agent (SPEC F5, §14). The tool loop: on each user message the agent
 * calls the model with the tool schemas, executes tool calls through the
 * service layer (identity/basket injected from the session — never from the
 * model), and loops until the model returns prose or a per-turn/per-session
 * budget is hit. Messages + tool calls/results persist to chat_sessions/
 * chat_messages for full replay.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { chatSessions, chatMessages } from '../../db/schema/index.js';
import {
  OpenRouterService,
  SpendCapExceededError,
  type LlmMessage,
} from '../../integrations/openrouter/index.js';
import { SALES_AGENT_SYSTEM_PROMPT } from './system-prompt.js';
import { TOOL_SCHEMAS, ToolExecutor, type ToolContext } from './tools.js';
import { BasketService, type BasketView } from './basket.service.js';

const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_TOOL_CALLS_PER_SESSION = 60;

export interface TurnResult {
  content: string;
  basket: BasketView;
  toolCallsThisTurn: number;
  windDown?: 'spend_cap' | 'tool_budget';
}

export class AgentService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private llm: OpenRouterService;
  private tools = new ToolExecutor();
  private basket = new BasketService();

  constructor(llm?: OpenRouterService) {
    this.llm = llm ?? new OpenRouterService();
  }

  /** Start a chat session with its own basket. */
  async startSession(userId?: string): Promise<{ sessionId: string; basketId: string }> {
    const basketId = await this.basket.createBasket(userId);
    const [session] = await this.db
      .insert(chatSessions)
      .values({ companyId: this.companyId, userId: userId ?? null, basketId })
      .returning({ id: chatSessions.id });
    return { sessionId: session!.id, basketId };
  }

  private async sessionToolCallCount(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(sql`${chatMessages.sessionId} = ${sessionId} AND ${chatMessages.role} = 'tool'`);
    return Number(row?.n ?? 0);
  }

  private async history(sessionId: string): Promise<LlmMessage[]> {
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.createdAt));
    return rows.map((r) => {
      if (r.role === 'tool') {
        const meta = (r.toolCalls as Array<{ id: string; name: string }>) ?? [];
        return { role: 'tool' as const, content: r.content, toolCallId: meta[0]?.id, name: meta[0]?.name };
      }
      if (r.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: r.content,
          toolCalls: (r.toolCalls as LlmMessage['toolCalls']) ?? undefined,
        };
      }
      return { role: 'user' as const, content: r.content };
    });
  }

  private async persist(
    sessionId: string,
    msg: { role: 'user' | 'assistant' | 'tool'; content: string | null; toolCalls?: unknown; toolResults?: unknown },
  ): Promise<void> {
    await this.db.insert(chatMessages).values({
      companyId: this.companyId,
      sessionId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls ?? null,
      toolResults: msg.toolResults ?? null,
    });
  }

  async runTurn(sessionId: string, userText: string): Promise<TurnResult> {
    const [session] = await this.db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1);
    if (!session || !session.basketId) throw new Error('session not found');
    const ctx: ToolContext = {
      userId: session.userId,
      basketId: session.basketId,
      chatSessionId: sessionId,
    };

    await this.persist(sessionId, { role: 'user', content: userText });

    const messages: LlmMessage[] = [
      { role: 'system', content: SALES_AGENT_SYSTEM_PROMPT },
      ...(await this.history(sessionId)),
    ];

    let toolCallsThisTurn = 0;
    let windDown: TurnResult['windDown'];

    for (let step = 0; step < MAX_TOOL_CALLS_PER_TURN + 1; step++) {
      let result;
      try {
        result = await this.llm.complete({ messages, tools: TOOL_SCHEMAS, purpose: 'chat' });
      } catch (e) {
        if (e instanceof SpendCapExceededError) {
          windDown = 'spend_cap';
          break;
        }
        throw e;
      }

      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });
      await this.persist(sessionId, {
        role: 'assistant',
        content: result.content,
        toolCalls: result.toolCalls.length ? result.toolCalls : null,
      });

      if (result.toolCalls.length === 0) {
        return { content: result.content ?? '', basket: await this.basket.view(ctx.basketId), toolCallsThisTurn };
      }

      // Per-turn and per-session tool budgets.
      if (toolCallsThisTurn + result.toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
        windDown = 'tool_budget';
        break;
      }
      if ((await this.sessionToolCallCount(sessionId)) + result.toolCalls.length > MAX_TOOL_CALLS_PER_SESSION) {
        windDown = 'tool_budget';
        break;
      }

      for (const call of result.toolCalls) {
        const envelope = await this.tools.execute(call.name, call.arguments, ctx);
        toolCallsThisTurn++;
        const content = JSON.stringify(envelope);
        messages.push({ role: 'tool', content, toolCallId: call.id, name: call.name });
        await this.persist(sessionId, {
          role: 'tool',
          content,
          toolCalls: [{ id: call.id, name: call.name }],
          toolResults: envelope,
        });
      }
    }

    const content = windDown === 'spend_cap'
      ? "I'm going to have to pause here — let me hand you a summary and you can pick up from your basket."
      : "Let's take stock of your basket before we go further.";
    return { content, basket: await this.basket.view(ctx.basketId), toolCallsThisTurn, windDown };
  }
}
