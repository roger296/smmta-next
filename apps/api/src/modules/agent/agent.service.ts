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
import { getEnv } from '../../config/env.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  chatSessions,
  chatMessages,
  chatClassifications,
  type ChatClassifierOutcome,
} from '../../db/schema/index.js';
import {
  OpenRouterService,
  SpendCapExceededError,
  type LlmMessage,
} from '../../integrations/openrouter/index.js';
import { SALES_AGENT_SYSTEM_PROMPT } from './system-prompt.js';
import { ToolExecutor, toolsForCategory, type ToolContext } from './tools.js';
import { BasketService, type BasketView } from './basket.service.js';
import { ChatbotConfigService } from './chatbot-config.service.js';
import { ClassifierService, type Classification } from './classifier.service.js';
import {
  EscalationService,
  defaultPriorityFor,
  legacyReasonFor,
} from './escalation.service.js';
import { RULE_BASED_REPLIES } from './default-prompts.js';

const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_TOOL_CALLS_PER_SESSION = 60;

/**
 * Specialists whose tools are actually wired up, and which may
 * therefore receive their own system prompt.
 *
 * `commercial_offer` and `complaint` are absent deliberately even
 * though they ARE built: they never reach a system prompt at all,
 * because they short-circuit to the escalation path before any model
 * is called. This set only governs LLM-backed routing.
 *
 * Still falling through to `pre_sales` until their phases land:
 *   order_status      needs lookup_order_by_account / _by_ref_and_email
 *   delivery_returns  needs lookup_kb (knowledge base)
 *   product_advice    needs lookup_kb (knowledge base)
 *
 * Add a category here in the same commit that lands its tools — not
 * before. The classifier already records traffic for all of them.
 */
const READY_SPECIALISTS = new Set<string>(['pre_sales', 'delivery_returns']);

export interface TurnResult {
  content: string;
  basket: BasketView;
  toolCallsThisTurn: number;
  windDown?: 'spend_cap' | 'tool_budget';
  /** What stage 1 decided this turn was about. Surfaced for the admin
   *  test bench and for debugging a reply that reads oddly. */
  category?: ChatClassifierOutcome;
}

export class AgentService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private llm: OpenRouterService;
  private tools = new ToolExecutor();
  private basket = new BasketService();
  private config: ChatbotConfigService;
  private classifier: ClassifierService;
  private escalations: EscalationService;

  constructor(
    llm?: OpenRouterService,
    config?: ChatbotConfigService,
    classifier?: ClassifierService,
    escalations?: EscalationService,
  ) {
    this.llm = llm ?? new OpenRouterService();
    this.config = config ?? new ChatbotConfigService();
    this.classifier = classifier ?? new ClassifierService(this.llm);
    this.escalations = escalations ?? new EscalationService();
  }

  /**
   * Stage 1. Returns the safe default (`pre_sales`, low confidence) when
   * the classifier is switched off by env, or when anything at all goes
   * wrong inside it — that default is precisely the behaviour this
   * pipeline replaced, so a bad classifier degrades to the old chat
   * rather than to no chat.
   */
  private async classifyTurn(
    userText: string,
    history: LlmMessage[],
  ): Promise<Classification> {
    const disabled: Classification = {
      category: 'pre_sales',
      confidence: 'low',
      clarifyPrompt: null,
      refusalReason: null,
      latencyMs: 0,
      costMicroUsd: 0,
      degraded: true,
      degradedReason: null,
    };
    if (!getEnv().CHAT_CLASSIFIER_ENABLED) return disabled;
    try {
      const cfg = await this.config.get();
      return await this.classifier.classify(cfg.classifierPrompt, userText, history);
    } catch {
      return disabled;
    }
  }

  /**
   * The classifier outcomes that answer without calling a model.
   *
   * `irrelevant` returns the operator's configured refusal verbatim —
   * never model-generated, so a jailbreak that gets itself classified
   * off-topic can't also author the reply. `ambiguous` asks the
   * classifier's own clarifying question back.
   *
   * `commercial_offer` and `complaint` escalate to a human and return
   * fixed acknowledgement copy. No model is involved by design: trade
   * terms are founder-only territory, and an AI-drafted apology on a
   * real complaint is a legal and reputational risk.
   *
   * Returns null when the turn should go on to a specialist.
   */
  private async shortCircuitReply(
    c: Classification,
    ctx: { sessionId: string; userText: string; history: LlmMessage[] },
  ): Promise<string | null> {
    if (c.category === 'irrelevant') {
      const cfg = await this.config.get().catch(() => null);
      return (
        cfg?.offtopicRefusal ??
        "I can only help with questions about this store's products and orders."
      );
    }
    if (c.category === 'ambiguous' && c.clarifyPrompt) return c.clarifyPrompt;

    if (c.category === 'commercial_offer' || c.category === 'complaint') {
      return this.escalateAndAcknowledge(c.category, ctx);
    }
    return null;
  }

  /**
   * Rule-based specialist: file the escalation, email the operator, and
   * return the fixed acknowledgement.
   *
   * If the notification email doesn't actually go out we say something
   * weaker — the customer is not told "someone will be in touch" when
   * nothing reached the mailbox. Better to point them at the email
   * address themselves than to make a promise the system didn't keep.
   */
  private async escalateAndAcknowledge(
    category: 'commercial_offer' | 'complaint',
    ctx: { sessionId: string; userText: string; history: LlmMessage[] },
  ): Promise<string> {
    const cfg = await this.config.get().catch(() => null);
    const to = cfg?.escalationEmail ?? 'sales@cleverdeals.net';

    const recentTurns = ctx.history
      .filter((m): m is LlmMessage & { content: string } =>
        (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '',
      )
      .slice(-3)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    recentTurns.push({ role: 'user', content: ctx.userText });

    let emailSent = false;
    try {
      const result = await this.escalations.escalate({
        chatSessionId: ctx.sessionId,
        chatCategory: category,
        reason: legacyReasonFor(category),
        summary: ctx.userText.slice(0, 500),
        priority: defaultPriorityFor(category, ctx.userText),
        to,
        storeName: cfg?.storeName ?? 'the store',
        recentTurns,
      });
      emailSent = result.emailSent;
    } catch {
      emailSent = false;
    }

    if (emailSent) return RULE_BASED_REPLIES[category]!;
    return category === 'complaint'
      ? `I'm sorry that's happened — I'm not able to put this in front of the team automatically right now. Please email ${to} with your order number and a photo if you have one, and they'll pick it up.`
      : `Thanks — that's one for our sales team rather than me, but I couldn't pass it on automatically just now. Please email ${to} directly and they'll come back to you.`;
  }

  /** Audit row per classified turn. Best-effort: a logging failure must
   *  never break the customer's conversation. */
  private async recordClassification(
    sessionId: string,
    c: Classification,
    turnOrdinal: number,
  ): Promise<void> {
    try {
      await this.db.insert(chatClassifications).values({
        companyId: this.companyId,
        sessionId,
        turnOrdinal,
        category: c.category,
        confidence: c.confidence,
        latencyMs: c.latencyMs,
        costMicroUsd: c.costMicroUsd,
      });
    } catch {
      /* audit only — never break the turn */
    }
  }

  /**
   * The system prompt for a turn, chosen by the classifier's category.
   *
   * A specialist is only routed to once its TOOLS exist. Handing the
   * order-status prompt to a model with no order-lookup tools would
   * produce an assistant that talks confidently about checking an order
   * it has no way to read — worse than the honest sales prompt. Until a
   * specialist's phase lands, its traffic falls through to `pre_sales`,
   * which is exactly how chat behaved before the classifier. The
   * classification is still recorded, so the traffic mix for the
   * not-yet-built specialists is visible before we build them.
   *
   * A disabled specialist (admin toggle) also falls through here.
   *
   * Final fallback is the compiled-in SPEC F5 constant: a database
   * hiccup should change the assistant's wording, not take chat offline.
   */
  private async systemPromptFor(
    category: ChatClassifierOutcome = 'pre_sales',
  ): Promise<string> {
    const target = READY_SPECIALISTS.has(category) ? category : 'pre_sales';
    try {
      const cfg = await this.config.get();
      const specialist = cfg.specialists.get(target as never);
      if (specialist?.enabled && specialist.systemPrompt) return specialist.systemPrompt;
      // Disabled or empty → fall back to pre_sales, then to the constant.
      const fallbackSpecialist = cfg.specialists.get('pre_sales');
      if (fallbackSpecialist?.systemPrompt) return fallbackSpecialist.systemPrompt;
    } catch {
      /* fall through to the compiled-in default */
    }
    return SALES_AGENT_SYSTEM_PROMPT;
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

    // Stage 1 — classify BEFORE persisting the user turn, so the
    // classifier sees the history as it was, not including this message
    // twice. Never throws: a classifier failure degrades to pre_sales.
    const priorHistory = await this.history(sessionId);
    const classification = await this.classifyTurn(userText, priorHistory);

    await this.persist(sessionId, { role: 'user', content: userText });
    await this.recordClassification(sessionId, classification, priorHistory.length);

    // Short-circuits — none of these spend a specialist call.
    const shortCircuit = await this.shortCircuitReply(classification, {
      sessionId,
      userText,
      history: priorHistory,
    });
    if (shortCircuit) {
      await this.persist(sessionId, { role: 'assistant', content: shortCircuit });
      return {
        content: shortCircuit,
        basket: await this.basket.view(ctx.basketId),
        toolCallsThisTurn: 0,
        category: classification.category,
      };
    }

    // The specialist that will actually answer — the classified category
    // when its tools are wired, else pre_sales. Prompt AND tools are
    // both taken from it, so they can never disagree about what this
    // specialist is allowed to do.
    const routedTo = READY_SPECIALISTS.has(classification.category)
      ? classification.category
      : 'pre_sales';
    const tools = toolsForCategory(routedTo);

    const messages: LlmMessage[] = [
      { role: 'system', content: await this.systemPromptFor(classification.category) },
      ...(await this.history(sessionId)),
    ];

    let toolCallsThisTurn = 0;
    let windDown: TurnResult['windDown'];

    for (let step = 0; step < MAX_TOOL_CALLS_PER_TURN + 1; step++) {
      let result;
      try {
        result = await this.llm.complete({ messages, tools, purpose: 'chat' });
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

  /**
   * Run one message through the pipeline for the admin test bench and
   * report every stage, without touching real state.
   *
   * "Without touching real state" is doing real work here: the bench
   * creates its own throwaway session + basket, so nothing lands in a
   * customer's chat history and no live basket is mutated. Tool calls
   * still execute — a read-only tool like search_catalogue must run for
   * the bench to be worth anything — but they run against the scratch
   * basket, so an add_to_basket in a test only ever fills a basket that
   * is abandoned the moment this returns.
   */
  async dryRun(message: string): Promise<{
    sessionId: string;
    classification: Classification;
    routedTo: string;
    systemPrompt: string;
    reply: string;
    toolCalls: number;
    windDown: TurnResult['windDown'];
    basket: BasketView;
  }> {
    const { sessionId } = await this.startSession();

    // Classify separately first so the bench can show stage 1's verdict
    // even when the turn short-circuits. runTurn classifies again on its
    // own — two calls on a bench run is a fair price for showing the
    // operator exactly what each stage decided.
    const classification = await this.classifyTurn(message, []);
    const routedTo = READY_SPECIALISTS.has(classification.category)
      ? classification.category
      : 'pre_sales';
    const systemPrompt = await this.systemPromptFor(classification.category);

    const result = await this.runTurn(sessionId, message);
    return {
      sessionId,
      classification,
      routedTo,
      systemPrompt,
      reply: result.content,
      toolCalls: result.toolCallsThisTurn,
      windDown: result.windDown,
      basket: result.basket,
    };
  }
}
