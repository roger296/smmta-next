/**
 * Loads the store's chatbot configuration and prompts, seeding defaults
 * on first use.
 *
 * Reads are hot-pathed on every chat turn, so the resolved config is
 * cached in-process with a short TTL. The TTL (rather than an explicit
 * invalidation bus) is deliberate: the API is a single process per
 * deploy, an admin save calls `invalidate()` directly, and a 30-second
 * worst case for a prompt edit to take effect is well inside what the
 * admin test bench needs to feel live.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  chatbotConfig,
  specialistPrompts,
  promptVersions,
  CHAT_CATEGORIES,
  type ChatCategory,
} from '../../db/schema/index.js';
import {
  DEFAULT_CLASSIFIER_PROMPT,
  DEFAULT_OFFTOPIC_REFUSAL,
  DEFAULT_SPECIALISTS,
  renderPrompt,
} from './default-prompts.js';

const CACHE_TTL_MS = 30_000;

export interface ResolvedSpecialist {
  category: ChatCategory;
  /** Placeholders already interpolated — ready to send as a system prompt. */
  systemPrompt: string;
  modelOverride: string | null;
  enabled: boolean;
  version: number;
}

export interface ResolvedChatbotConfig {
  storeName: string;
  productKind: string;
  /** Placeholders already interpolated. */
  classifierPrompt: string;
  /** Placeholders already interpolated. */
  offtopicRefusal: string;
  escalationEmail: string;
  specialists: Map<ChatCategory, ResolvedSpecialist>;
}

interface CacheEntry {
  value: ResolvedChatbotConfig;
  expiresAt: number;
}

/** Seed values used when a deploy has no config row yet. Store name and
 *  product kind are intentionally generic — the operator sets the real
 *  ones in admin, and a wrong-but-obvious placeholder is safer than
 *  guessing a brand from an env var. */
const SEED_STORE_NAME = 'our store';
const SEED_PRODUCT_KIND = 'our products';
const SEED_ESCALATION_EMAIL = 'sales@cleverdeals.net';

export class ChatbotConfigService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private cache: CacheEntry | null = null;

  /** Drop the cache. Called by the admin routes after any save so an
   *  edit is visible on the very next request rather than up to a TTL
   *  later — the test bench depends on this. */
  invalidate(): void {
    this.cache = null;
  }

  async get(): Promise<ResolvedChatbotConfig> {
    const now = Date.now();
    if (this.cache && now < this.cache.expiresAt) return this.cache.value;
    const value = await this.load();
    this.cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  private async load(): Promise<ResolvedChatbotConfig> {
    const row = (await this.readConfigRow()) ?? (await this.seedConfigRow());
    const specialistRows = await this.readSpecialistRows();
    const missing = CHAT_CATEGORIES.filter(
      (c) => !specialistRows.some((r) => r.category === c),
    );
    if (missing.length > 0) {
      await this.seedSpecialistRows(missing);
      specialistRows.push(...(await this.readSpecialistRows()).filter((r) =>
        missing.includes(r.category as ChatCategory),
      ));
    }

    const vars = { storeName: row.storeName, productKind: row.productKind };
    const specialists = new Map<ChatCategory, ResolvedSpecialist>();
    for (const r of specialistRows) {
      if (!CHAT_CATEGORIES.includes(r.category as ChatCategory)) continue;
      specialists.set(r.category as ChatCategory, {
        category: r.category as ChatCategory,
        systemPrompt: renderPrompt(r.systemPrompt, vars),
        modelOverride: r.modelOverride,
        enabled: r.enabled,
        version: r.version,
      });
    }

    return {
      storeName: row.storeName,
      productKind: row.productKind,
      classifierPrompt: renderPrompt(row.classifierPrompt, vars),
      offtopicRefusal: renderPrompt(row.offtopicRefusal, vars),
      escalationEmail: row.escalationEmail,
      specialists,
    };
  }

  private async readConfigRow() {
    const [row] = await this.db
      .select()
      .from(chatbotConfig)
      .where(eq(chatbotConfig.companyId, this.companyId))
      .limit(1);
    return row;
  }

  private async seedConfigRow() {
    const [row] = await this.db
      .insert(chatbotConfig)
      .values({
        companyId: this.companyId,
        storeName: SEED_STORE_NAME,
        productKind: SEED_PRODUCT_KIND,
        classifierPrompt: DEFAULT_CLASSIFIER_PROMPT,
        offtopicRefusal: DEFAULT_OFFTOPIC_REFUSAL,
        escalationEmail: SEED_ESCALATION_EMAIL,
      })
      .returning();
    return row!;
  }

  private async readSpecialistRows() {
    return this.db
      .select()
      .from(specialistPrompts)
      .where(eq(specialistPrompts.companyId, this.companyId));
  }

  private async seedSpecialistRows(categories: ChatCategory[]): Promise<void> {
    const toInsert = DEFAULT_SPECIALISTS.filter((d) =>
      categories.includes(d.category as ChatCategory),
    ).map((d) => ({
      companyId: this.companyId,
      category: d.category,
      systemPrompt: d.systemPrompt,
      enabled: d.enabled,
      version: 1,
    }));
    if (toInsert.length === 0) return;
    await this.db.insert(specialistPrompts).values(toInsert);
  }

  // ----------------------------------------------------------
  // Writes (admin)
  // ----------------------------------------------------------

  /** Update the store profile fields. Returns the fresh resolved config. */
  async updateProfile(
    patch: Partial<{
      storeName: string;
      productKind: string;
      offtopicRefusal: string;
      escalationEmail: string;
    }>,
    userId?: string,
  ): Promise<ResolvedChatbotConfig> {
    await this.get(); // ensure a row exists
    await this.db
      .update(chatbotConfig)
      .set({ ...patch, updatedBy: userId ?? null, updatedAt: new Date() })
      .where(eq(chatbotConfig.companyId, this.companyId));
    this.invalidate();
    return this.get();
  }

  /** Save a new classifier prompt, appending a history row. */
  async updateClassifierPrompt(body: string, userId?: string): Promise<ResolvedChatbotConfig> {
    await this.get();
    await this.db
      .update(chatbotConfig)
      .set({ classifierPrompt: body, updatedBy: userId ?? null, updatedAt: new Date() })
      .where(eq(chatbotConfig.companyId, this.companyId));
    await this.appendVersion('classifier', body, userId);
    this.invalidate();
    return this.get();
  }

  /** Save a specialist's prompt / model / enabled flag. Bumps `version`
   *  and appends a history row whenever the prompt body changed. */
  async updateSpecialist(
    category: ChatCategory,
    patch: Partial<{ systemPrompt: string; modelOverride: string | null; enabled: boolean }>,
    userId?: string,
  ): Promise<ResolvedChatbotConfig> {
    await this.get();
    const [existing] = await this.db
      .select()
      .from(specialistPrompts)
      .where(
        and(
          eq(specialistPrompts.companyId, this.companyId),
          eq(specialistPrompts.category, category),
        ),
      )
      .limit(1);
    if (!existing) throw new Error(`unknown specialist category: ${category}`);

    const bodyChanged =
      patch.systemPrompt !== undefined && patch.systemPrompt !== existing.systemPrompt;
    const nextVersion = bodyChanged ? existing.version + 1 : existing.version;

    await this.db
      .update(specialistPrompts)
      .set({
        ...patch,
        version: nextVersion,
        updatedBy: userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(specialistPrompts.id, existing.id));

    if (bodyChanged) {
      await this.appendVersion(`specialist:${category}`, patch.systemPrompt!, userId, nextVersion);
    }
    this.invalidate();
    return this.get();
  }

  private async appendVersion(
    target: string,
    body: string,
    userId?: string,
    version?: number,
  ): Promise<void> {
    const resolved = version ?? (await this.nextVersionFor(target));
    await this.db.insert(promptVersions).values({
      companyId: this.companyId,
      target,
      version: resolved,
      body,
      savedBy: userId ?? null,
    });
  }

  private async nextVersionFor(target: string): Promise<number> {
    const rows = await this.db
      .select({ version: promptVersions.version })
      .from(promptVersions)
      .where(and(eq(promptVersions.companyId, this.companyId), eq(promptVersions.target, target)));
    const max = rows.reduce((m, r) => Math.max(m, r.version), 0);
    return max + 1;
  }

  /** History for the admin rollback dropdown, newest first. */
  async listVersions(target: string, limit = 20) {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.companyId, this.companyId), eq(promptVersions.target, target)));
    return rows.sort((a, b) => b.version - a.version).slice(0, limit);
  }
}
