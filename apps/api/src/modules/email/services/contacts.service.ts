/**
 * Contacts and consent (spec § Data model, § Email classes → Status
 * transitions). The only code that changes `marketing_status`: it writes the
 * consent event first and the contact second, inside one transaction, which
 * is what the database trigger checks for.
 *
 * Transition rules:
 *  - Downgrades to `transactional_only` happen from any source (an unsubscribe
 *    or a complaint must always work). Imports may downgrade, never upgrade.
 *  - Upgrades to `all` come only from a form the person submitted (checkout,
 *    signup form, preferences page) or an admin / MCP action with a reason
 *    and `confirm: true`.
 *  - `never` is set, and left, only by an admin / MCP action with a reason
 *    and `confirm: true`. Nothing a person submits and no import moves a
 *    contact out of `never`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  emailConsentEvents,
  emailContacts,
  type Deliverability,
  type InterestMap,
  type MarketingStatus,
} from '../../../db/schema/index.js';
import type { Executor } from '../lib/db.js';
import { emitDomainEvent, type DbTx } from '../../../shared/events/emit.js';

/** Sources whose new contacts are address-verified (spec § Bouncer). */
export const VERIFY_SOURCES = ['checkout', 'signup_form', 'back_in_stock_form', 'pre_order', 'subscription'] as const;
import { isValidEmail, normaliseEmail } from '../lib/normalise.js';
import { addInterestPoints, decayAll, type InterestPolicy } from '../lib/interests.js';

export type Contact = typeof emailContacts.$inferSelect;

/** Sources that are a person submitting a form about their own address. */
export const PERSON_FORM_SOURCES = ['checkout', 'signup_form', 'preferences_page'] as const;
/** Sources that are an operator acting on someone's behalf. */
export const OPERATOR_SOURCES = ['admin_ui', 'mcp'] as const;
/** Sources that are a bulk list import. */
export const IMPORT_SOURCES = ['csv_import', 'sendgrid_import'] as const;

export class ConsentTransitionError extends Error {
  constructor(
    message: string,
    public readonly code: 'forbidden' | 'confirm_required' | 'reason_required' | 'not_found' | 'invalid_email',
  ) {
    super(message);
  }
}

export interface StatusChange {
  source: string;
  /** A user id, `claude`, `system` or `person`. */
  actor: string;
  reason?: string;
  ip?: string;
  userAgent?: string;
  confirm?: boolean;
  evidence?: Record<string, unknown>;
}

export interface FindOrCreateOptions {
  customerId?: string | null;
  storefrontUserId?: string | null;
  /** consent_source on a new contact. */
  source: string;
  actor?: string;
  /** Status a NEW contact starts at; existing contacts are not changed here. */
  initialStatus?: MarketingStatus;
  consentAt?: Date | null;
  evidence?: Record<string, unknown>;
  isTrade?: boolean;
  interests?: InterestMap;
  ip?: string;
  userAgent?: string;
}

type ContactCreatedHook = (contact: Contact, source: string) => Promise<void> | void;
const createdHooks: ContactCreatedHook[] = [];

/** Run after a new contact commits (Bouncer verification registers here). */
export function onContactCreated(hook: ContactCreatedHook): () => void {
  createdHooks.push(hook);
  return () => {
    const i = createdHooks.indexOf(hook);
    if (i >= 0) createdHooks.splice(i, 1);
  };
}

const RANK: Record<MarketingStatus, number> = { never: 0, transactional_only: 1, all: 2 };

/** Throws when the transition is not allowed; returns quietly when it is. */
export function checkTransition(from: MarketingStatus, to: MarketingStatus, change: StatusChange): void {
  if (from === to) return;
  const operator = (OPERATOR_SOURCES as readonly string[]).includes(change.source);
  const personForm = (PERSON_FORM_SOURCES as readonly string[]).includes(change.source);
  const imported = (IMPORT_SOURCES as readonly string[]).includes(change.source);

  const needsOperator = to === 'never' || from === 'never';
  if (needsOperator) {
    if (!operator) {
      throw new ConsentTransitionError(
        from === 'never'
          ? 'only an admin can move a contact out of "never email"'
          : 'only an admin can set "never email"',
        'forbidden',
      );
    }
    if (!change.reason?.trim()) throw new ConsentTransitionError('a reason is required', 'reason_required');
    if (!change.confirm) throw new ConsentTransitionError('confirm: true is required', 'confirm_required');
    return;
  }

  if (RANK[to] > RANK[from]) {
    if (imported) throw new ConsentTransitionError('an import never upgrades consent', 'forbidden');
    if (personForm) return;
    if (operator) {
      if (!change.reason?.trim()) throw new ConsentTransitionError('a reason is required', 'reason_required');
      if (!change.confirm) throw new ConsentTransitionError('confirm: true is required', 'confirm_required');
      return;
    }
    throw new ConsentTransitionError(`source ${change.source} cannot upgrade consent`, 'forbidden');
  }
  // Downgrade (all → transactional_only): always allowed.
}

export class ContactsService {
  private get db() {
    return getDb();
  }

  async get(id: string, ex: Executor = this.db): Promise<Contact | undefined> {
    const [row] = await ex.select().from(emailContacts).where(eq(emailContacts.id, id)).limit(1);
    return row;
  }

  async getByEmail(email: string, ex: Executor = this.db): Promise<Contact | undefined> {
    const [row] = await ex
      .select()
      .from(emailContacts)
      .where(eq(emailContacts.email, normaliseEmail(email)))
      .limit(1);
    return row;
  }

  async getByToken(token: string, ex: Executor = this.db): Promise<Contact | undefined> {
    if (!token || token.length > 64) return undefined;
    const [row] = await ex.select().from(emailContacts).where(eq(emailContacts.unsubscribeToken, token)).limit(1);
    return row;
  }

  /**
   * The contact for an address, created if new. An existing contact is linked
   * to the customer / storefront user when it was not already; its consent is
   * never changed here (use setMarketingStatus). Pass `ex` to take part in a
   * caller's transaction; the created-hooks then run only when you call
   * `runCreatedHooks` after your commit.
   */
  async findOrCreateByEmail(
    rawEmail: string,
    opts: FindOrCreateOptions,
    ex?: Executor,
  ): Promise<{ contact: Contact; created: boolean }> {
    const email = normaliseEmail(rawEmail);
    if (!isValidEmail(email)) throw new ConsentTransitionError('not a valid email address', 'invalid_email');

    const run = async (tx: Executor) => {
      const existing = await this.getByEmail(email, tx);
      if (existing) {
        const patch: Partial<Contact> = {};
        if (opts.customerId && !existing.customerId) patch.customerId = opts.customerId;
        if (opts.storefrontUserId && !existing.storefrontUserId) patch.storefrontUserId = opts.storefrontUserId;
        if (opts.isTrade && !existing.isTrade) patch.isTrade = true;
        if (Object.keys(patch).length === 0) return { contact: existing, created: false };
        const [updated] = await tx
          .update(emailContacts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(emailContacts.id, existing.id))
          .returning();
        return { contact: updated!, created: false };
      }

      const status = opts.initialStatus ?? 'transactional_only';
      const [inserted] = await tx
        .insert(emailContacts)
        .values({
          companyId: getSingletonCompanyId(),
          email,
          customerId: opts.customerId ?? null,
          storefrontUserId: opts.storefrontUserId ?? null,
          marketingStatus: status,
          consentSource: opts.source,
          consentAt: opts.consentAt ?? (status === 'all' ? new Date() : null),
          consentEvidence: opts.evidence ?? {},
          isTrade: opts.isTrade ?? false,
          interests: opts.interests ?? {},
        })
        .onConflictDoNothing({ target: emailContacts.email })
        .returning();
      if (!inserted) {
        // Lost a race with another writer: theirs stands.
        const row = await this.getByEmail(email, tx);
        return { contact: row!, created: false };
      }
      await tx.insert(emailConsentEvents).values({
        companyId: inserted.companyId,
        contactId: inserted.id,
        fromStatus: null,
        toStatus: status,
        source: opts.source,
        actor: opts.actor ?? 'system',
        ip: opts.ip,
        userAgent: opts.userAgent,
        evidence: opts.evidence,
      });
      if ((VERIFY_SOURCES as readonly string[]).includes(opts.source)) {
        // Address verification runs in the worker, after this commits.
        await emitDomainEvent(tx as DbTx, {
          eventType: 'email.contact_created',
          aggregateType: 'email_contact',
          aggregateId: inserted.id,
          payload: { contactId: inserted.id, source: opts.source },
        });
      }
      return { contact: inserted, created: true };
    };

    if (ex) return ex.transaction((tx) => run(tx));
    const result = await this.db.transaction((tx) => run(tx));
    if (result.created) await this.runCreatedHooks(result.contact, opts.source);
    return result;
  }

  async runCreatedHooks(contact: Contact, source: string): Promise<void> {
    for (const hook of createdHooks) {
      try {
        await hook(contact, source);
      } catch {
        // A hook (e.g. queueing verification) must never fail the request
        // that created the contact.
      }
    }
  }

  /**
   * Move a contact's marketing status. Writes exactly one consent event when
   * the status changes and none when it does not. Throws
   * ConsentTransitionError for a transition the rules forbid.
   */
  async setMarketingStatus(
    contactId: string,
    to: MarketingStatus,
    change: StatusChange,
    ex?: Executor,
  ): Promise<{ changed: boolean; from: MarketingStatus; to: MarketingStatus }> {
    const run = async (tx: Executor) => {
      const [current] = await tx
        .select()
        .from(emailContacts)
        .where(eq(emailContacts.id, contactId))
        .for('update')
        .limit(1);
      if (!current) throw new ConsentTransitionError('contact not found', 'not_found');
      const from = current.marketingStatus;
      if (from === to) return { changed: false, from, to };
      checkTransition(from, to, change);

      await tx.insert(emailConsentEvents).values({
        companyId: current.companyId,
        contactId,
        fromStatus: from,
        toStatus: to,
        source: change.source,
        actor: change.actor,
        reason: change.reason,
        ip: change.ip,
        userAgent: change.userAgent,
        evidence: change.evidence,
      });
      const now = new Date();
      await tx
        .update(emailContacts)
        .set({
          marketingStatus: to,
          statusChangedAt: now,
          statusReason: change.reason ?? change.source,
          // A person (or operator) choosing marketing is fresh consent.
          ...(to === 'all' ? { consentSource: change.source, consentAt: now } : {}),
          ...(to === 'all' && change.evidence ? { consentEvidence: change.evidence } : {}),
          updatedAt: now,
        })
        .where(eq(emailContacts.id, contactId));
      return { changed: true, from, to };
    };
    // Always a (sub)transaction: the event and the update must share txid_current().
    return (ex ?? this.db).transaction((tx) => run(tx));
  }

  /**
   * Apply a deliverability signal.
   *  - delivered: clears the soft-bounce count (and a soft_bounce state).
   *  - soft_bounce: counts within the window; Bouncer-risky addresses go
   *    straight to hard_bounce on their first one.
   *  - hard_bounce / complained / invalid: set. They never revert by
   *    themselves; complained also needs a consent downgrade, which the
   *    caller makes through setMarketingStatus.
   */
  async recordDeliverability(
    contactId: string,
    signal: 'delivered' | 'soft_bounce' | 'hard_bounce' | 'complained' | 'invalid',
    now = new Date(),
    windowDays = 30,
    ex: Executor = this.db,
  ): Promise<Deliverability | undefined> {
    const c = await this.get(contactId, ex);
    if (!c) return undefined;
    let next: Partial<Contact> = {};
    switch (signal) {
      case 'delivered':
        next = { softBounceCount: 0, softBounceSince: null };
        if (c.deliverability === 'soft_bounce') next.deliverability = 'ok';
        break;
      case 'soft_bounce': {
        if (c.deliverability === 'hard_bounce' || c.deliverability === 'complained' || c.deliverability === 'invalid') {
          return c.deliverability;
        }
        if (c.bouncerResult === 'risky') {
          next = { deliverability: 'hard_bounce' };
          break;
        }
        const inWindow =
          c.softBounceSince && now.getTime() - c.softBounceSince.getTime() <= windowDays * 86_400_000;
        next = inWindow
          ? { deliverability: 'soft_bounce', softBounceCount: c.softBounceCount + 1 }
          : { deliverability: 'soft_bounce', softBounceCount: 1, softBounceSince: now };
        break;
      }
      case 'hard_bounce':
        if (c.deliverability === 'complained') return c.deliverability;
        next = { deliverability: 'hard_bounce' };
        break;
      case 'complained':
        next = { deliverability: 'complained' };
        break;
      case 'invalid':
        if (c.deliverability === 'complained' || c.deliverability === 'hard_bounce') return c.deliverability;
        next = { deliverability: 'invalid' };
        break;
    }
    const [row] = await ex
      .update(emailContacts)
      .set({ ...next, updatedAt: now })
      .where(eq(emailContacts.id, contactId))
      .returning({ deliverability: emailContacts.deliverability });
    return row?.deliverability;
  }

  async addInterest(
    contactId: string,
    keys: string[],
    points: number,
    now = new Date(),
    policy?: InterestPolicy,
    ex: Executor = this.db,
  ): Promise<void> {
    if (keys.length === 0) return;
    const c = await this.get(contactId, ex);
    if (!c) return;
    await ex
      .update(emailContacts)
      .set({ interests: addInterestPoints(c.interests, keys, points, now, policy), updatedAt: now })
      .where(eq(emailContacts.id, contactId));
  }

  /** Nightly: rewrite every contact's interest scores as of now. */
  async decayInterests(now = new Date(), policy?: InterestPolicy): Promise<number> {
    const rows = await this.db
      .select({ id: emailContacts.id, interests: emailContacts.interests })
      .from(emailContacts)
      .where(sql`${emailContacts.interests} <> '{}'::jsonb`);
    let n = 0;
    for (const r of rows) {
      await this.db
        .update(emailContacts)
        .set({ interests: decayAll(r.interests, now, policy) })
        .where(and(eq(emailContacts.id, r.id)));
      n++;
    }
    return n;
  }
}
