/**
 * compose-message (SPEC §12.3, F6/F7). One LLM call per customer-message via the
 * OpenRouter wrapper (purpose='compose') with a versioned per-templateKey
 * prompt; writes a message_drafts row (category, group_key, expires_at) and
 * emits draft.created. £ figures are computed by code and passed in as facts —
 * the model formats, never calculates.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { messageDrafts, agentConfig } from '../../db/schema/index.js';
import { emitDomainEvent } from '../../shared/events/emit.js';
import { OpenRouterService } from '../../integrations/openrouter/index.js';
import { getTemplate } from './templates.js';

export interface ComposeInput {
  userId: string;
  templateKey: string;
  triggerEventId?: string;
  facts?: Record<string, unknown>;
  /** Override the batching group key (e.g. shared across a back-in-stock fanout). */
  groupKey?: string;
  nowMs?: number;
}

export class ComposeService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private llm: OpenRouterService;

  constructor(llm?: OpenRouterService) {
    this.llm = llm ?? new OpenRouterService();
  }

  private async autoSendType(eventType: string): Promise<boolean> {
    const [row] = await this.db
      .select({ on: agentConfig.autoSendEnabled })
      .from(agentConfig)
      .where(eq(agentConfig.eventType, eventType))
      .limit(1);
    return row?.on ?? false;
  }

  async compose(input: ComposeInput): Promise<{ draftId: string }> {
    const template = getTemplate(input.templateKey);
    const nowMs = input.nowMs ?? Date.now();

    const result = await this.llm.complete({
      purpose: 'compose',
      messages: [
        { role: 'system', content: template.systemPrompt },
        { role: 'user', content: JSON.stringify({ facts: input.facts ?? {} }) },
      ],
    });

    const { subject, body } = parseDraft(result.content);
    const expiresAt = template.expiryHours ? new Date(nowMs + template.expiryHours * 3_600_000) : null;
    const groupKey = input.groupKey ?? `${input.templateKey}:${input.triggerEventId ?? 'marketing'}`;
    // Graduation (§17.6): auto-send only when the type is trusted. Keyed on the
    // template so a per-message-type toggle governs it.
    const auto = await this.autoSendType(input.templateKey);

    const draftId = await this.db.transaction(async (tx) => {
      const [draft] = await tx
        .insert(messageDrafts)
        .values({
          companyId: this.companyId,
          userId: input.userId,
          triggerEventId: input.triggerEventId ?? null,
          category: template.category,
          subject,
          body,
          status: auto ? 'auto_approved' : 'pending',
          groupKey,
          expiresAt,
        })
        .returning({ id: messageDrafts.id });
      await emitDomainEvent(tx, {
        eventType: 'draft.created',
        aggregateType: 'draft',
        aggregateId: draft!.id,
        payload: { draftId: draft!.id, templateKey: input.templateKey, userId: input.userId, auto },
      });
      // Auto-approved drafts proceed straight to send-message (§17.6).
      if (auto) {
        await emitDomainEvent(tx, {
          eventType: 'draft.approved',
          aggregateType: 'draft',
          aggregateId: draft!.id,
          payload: { draftId: draft!.id, auto: true },
        });
      }
      return draft!.id;
    });

    return { draftId };
  }
}

function parseDraft(content: string | null): { subject: string; body: string } {
  if (!content) return { subject: '(no subject)', body: '' };
  try {
    const parsed = JSON.parse(content) as { subject?: string; body?: string };
    return { subject: parsed.subject ?? '(no subject)', body: parsed.body ?? '' };
  } catch {
    // Model returned prose — use it as the body with a generic subject.
    return { subject: 'A quick update', body: content };
  }
}
