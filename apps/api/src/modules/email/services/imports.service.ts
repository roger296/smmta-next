/**
 * CSV importer (spec § CSV import; runbook section 4). Imports SendGrid's four
 * exports — bounces, spam reports, unsubscribes, marketing contacts — and any
 * later one-off list, so that the safest status always wins:
 *
 *   bounces       → deliverability hard_bounce + transactional_only
 *   spam_reports  → deliverability complained  + transactional_only
 *   unsubscribes  → transactional_only
 *   contacts      → `all`, but only for an address not already present
 *
 * Imports never upgrade consent and never touch a `never` contact. Every run
 * starts as a dry run that reports what would happen; a live run must name a
 * dry run of the same file (same SHA-256 and list type). Re-running a file
 * that was already imported live is a no-op. The file is streamed and written
 * in batches of 500; a copy goes to the evidence store with its hash so each
 * consent can be traced to its source row.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parse } from 'csv-parse';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getEnv } from '../../../config/env.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { customers, emailContacts, emailImports, type InterestMap, type MarketingStatus } from '../../../db/schema/index.js';
import { isValidEmail, maskEmail, normaliseEmail } from '../lib/normalise.js';
import { addInterestPoints, MATERIAL_KEYS, materialKeysInText } from '../lib/interests.js';
import { ContactsService, type Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';

export const LIST_TYPES = ['bounces', 'spam_reports', 'unsubscribes', 'contacts'] as const;
export type ListType = (typeof LIST_TYPES)[number];

const BATCH = 500;

export class ImportRefusedError extends Error {
  constructor(
    message: string,
    public readonly code: 'unknown_layout' | 'dry_run_required' | 'dry_run_mismatch' | 'bad_input',
    public readonly report?: ImportReport,
  ) {
    super(message);
  }
}

export interface ColumnMap {
  email: number;
  createdAt: number | null;
  lists: number | null;
  interests: number | null;
  headers: string[];
}

export interface Conflict {
  row: number;
  email: string;
  kind: 'would_downgrade' | 'would_upgrade_refused' | 'never_unchanged';
  from: MarketingStatus;
  to: MarketingStatus;
}

export interface ImportReport {
  importId?: string;
  listType: ListType;
  dryRun: boolean;
  filename: string;
  sha256: string;
  columns: { email: string; createdAt: string | null; lists: string | null; interests: string | null };
  rows_read: number;
  valid: number;
  invalid_syntax: number;
  duplicates_in_file: number;
  already_present: number;
  would_create: number;
  would_update: number;
  would_downgrade: number;
  would_upgrade_refused: number;
  linked_customers: number;
  conflicts: Conflict[];
  /** Live runs: what was written. */
  created?: number;
  updated?: number;
  skipped?: number;
  /** Set when this file had already been imported live. */
  already_imported?: boolean;
}

export interface RunImportInput {
  filePath: string;
  /** Name to record (defaults to the file's basename). */
  filename?: string;
  listType: ListType;
  /** Status for new contacts from a `contacts` list (default `all`). Never
   *  above what the list type allows. */
  defaultStatus?: MarketingStatus;
  /** Interest keys for rows that carry none of their own. */
  defaultInterests?: string[];
  /** consent_source on new contacts (default `sendgrid_import`). */
  consentSource?: string;
  dryRun: boolean;
  /** Required for a live run: the dry run it was approved from. */
  dryRunId?: string;
  actor: string;
}

const norm = (h: string) => h.toLowerCase().replace(/^﻿/, '').replace(/[^a-z0-9]/g, '');
const EMAIL_HEADERS = ['email', 'emailaddress', 'e-mail'].map(norm);
const CREATED_HEADERS = ['created_at', 'created', 'date_added', 'createdat', 'dateadded', 'subscribed_at'].map(norm);
const LIST_HEADERS = ['lists', 'list_names', 'listnames', 'list_name'].map(norm);

/** Finds the columns the importer reads. Null when no email column exists. */
export function detectColumns(headers: string[]): ColumnMap | null {
  const n = headers.map(norm);
  const find = (cands: string[]) => {
    for (const c of cands) {
      const i = n.indexOf(c);
      if (i >= 0) return i;
    }
    return null;
  };
  const email = find(EMAIL_HEADERS);
  if (email === null) return null;
  return {
    email,
    createdAt: find(CREATED_HEADERS),
    // LIST_IDS without a names column is ignored: ids mean nothing here.
    lists: find(LIST_HEADERS),
    interests: find(['interests']),
    headers,
  };
}

/** SendGrid writes unix seconds in API exports and dates in UI exports. */
export function parseCreated(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{9,11}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{12,14}$/.test(s)) return new Date(Number(s));
  const d = new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + (/[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Interest keys for one row (Part B #9): an `interests` column of
 *  semicolon-separated keys wins; then material names in the list names;
 *  then the upload's defaults. */
export function rowInterests(row: { interests?: string; lists?: string }, defaults: string[]): string[] {
  if (row.interests?.trim()) {
    return row.interests
      .split(';')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
      .map((k) => (k.includes(':') ? k : `material:${k}`));
  }
  if (row.lists?.trim()) {
    const keys = materialKeysInText(row.lists);
    if (keys.length) return keys;
  }
  return defaults;
}

interface Target {
  status: MarketingStatus;
  deliverability: 'hard_bounce' | 'complained' | null;
}

function targetFor(listType: ListType, defaultStatus: MarketingStatus): Target {
  switch (listType) {
    case 'bounces':
      return { status: 'transactional_only', deliverability: 'hard_bounce' };
    case 'spam_reports':
      return { status: 'transactional_only', deliverability: 'complained' };
    case 'unsubscribes':
      return { status: 'transactional_only', deliverability: null };
    case 'contacts':
      return { status: defaultStatus, deliverability: null };
  }
}

const RANK: Record<MarketingStatus, number> = { never: 0, transactional_only: 1, all: 2 };

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function evidenceDir(): string {
  return resolve(getEnv().EMAIL_EVIDENCE_DIR);
}

interface ParsedRow {
  row: number;
  email: string;
  createdAt: Date | null;
  interests: string[];
}

export class ImportsService {
  private contacts = new ContactsService();

  async get(id: string) {
    const [row] = await getDb().select().from(emailImports).where(eq(emailImports.id, id)).limit(1);
    return row;
  }

  async list(limit = 50) {
    return getDb().select().from(emailImports).orderBy(desc(emailImports.createdAt)).limit(limit);
  }

  async run(input: RunImportInput): Promise<ImportReport> {
    if (!LIST_TYPES.includes(input.listType)) throw new ImportRefusedError(`unknown list type ${input.listType}`, 'bad_input');
    const db = getDb();
    const filename = input.filename ?? basename(input.filePath);
    const sha256 = await sha256File(input.filePath);
    const defaultStatus = input.defaultStatus ?? (input.listType === 'contacts' ? 'all' : 'transactional_only');
    if (defaultStatus === 'never') {
      throw new ImportRefusedError('an import cannot set "never email"; an admin sets that per contact', 'bad_input');
    }
    const target = targetFor(input.listType, defaultStatus);
    const settings = await getEmailSettings();
    const threshold = settings.interest_decay.interested_threshold;
    const defaults = (input.defaultInterests ?? []).filter((k) => k.includes(':'));
    const consentSource = input.consentSource ?? 'sendgrid_import';

    if (!input.dryRun) {
      if (!input.dryRunId) throw new ImportRefusedError('a live import needs the id of a dry run of the same file', 'dry_run_required');
      const dry = await this.get(input.dryRunId);
      if (!dry || !dry.dryRun || dry.fileSha256 !== sha256 || dry.listType !== input.listType) {
        throw new ImportRefusedError(
          'the dry run does not match this file (different file, list type or not a dry run); run a new dry run',
          'dry_run_mismatch',
        );
      }
      const [done] = await db
        .select()
        .from(emailImports)
        .where(and(eq(emailImports.fileSha256, sha256), eq(emailImports.listType, input.listType), eq(emailImports.dryRun, false)))
        .limit(1);
      if (done) {
        return { ...(done.report as unknown as ImportReport), importId: done.id, already_imported: true, created: 0, updated: 0, skipped: 0 };
      }
    }

    // Read the header row first so an unknown layout stops before anything.
    const firstLine = (await readFile(input.filePath, 'utf8')).split(/\r?\n/, 1)[0] ?? '';
    const headerRecords = await new Promise<string[][]>((res, rej) =>
      parse(firstLine, { bom: true, relax_quotes: true }, (err, out: string[][]) => (err ? rej(err) : res(out))),
    );
    const headers = headerRecords[0] ?? [];
    const columns = detectColumns(headers);
    const report: ImportReport = {
      listType: input.listType,
      dryRun: input.dryRun,
      filename,
      sha256,
      columns: {
        email: columns ? headers[columns.email]! : '',
        createdAt: columns?.createdAt != null ? headers[columns.createdAt]! : null,
        lists: columns?.lists != null ? headers[columns.lists]! : null,
        interests: columns?.interests != null ? headers[columns.interests]! : null,
      },
      rows_read: 0,
      valid: 0,
      invalid_syntax: 0,
      duplicates_in_file: 0,
      already_present: 0,
      would_create: 0,
      would_update: 0,
      would_downgrade: 0,
      would_upgrade_refused: 0,
      linked_customers: 0,
      conflicts: [],
      ...(input.dryRun ? {} : { created: 0, updated: 0, skipped: 0 }),
    };
    if (!columns) {
      throw new ImportRefusedError(
        `no email column among the headers: ${headers.join(', ')}`,
        'unknown_layout',
        { ...report, columns: { email: '', createdAt: null, lists: null, interests: null } },
      );
    }

    // The import row first, so evidence can name it.
    const [imp] = await db
      .insert(emailImports)
      .values({
        companyId: getSingletonCompanyId(),
        filename,
        listType: input.listType,
        defaultStatus,
        defaultInterests: defaults,
        consentSource,
        fileSha256: sha256,
        dryRun: input.dryRun,
        dryRunId: input.dryRunId ?? null,
        createdBy: input.actor,
      })
      .returning();
    report.importId = imp!.id;

    let evidencePath: string | null = null;
    if (!input.dryRun) {
      await mkdir(evidenceDir(), { recursive: true });
      evidencePath = join(evidenceDir(), `${sha256}-${filename.replace(/[^A-Za-z0-9._-]/g, '_')}`);
      await copyFile(input.filePath, evidencePath);
    }

    const seen = new Set<string>();
    let batch: ParsedRow[] = [];
    const parser = createReadStream(input.filePath).pipe(
      parse({ bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, from_line: 2 }),
    );
    let rowNo = 1;
    for await (const rec of parser as AsyncIterable<string[]>) {
      rowNo++;
      report.rows_read++;
      const email = normaliseEmail(rec[columns.email] ?? '');
      if (!isValidEmail(email)) {
        report.invalid_syntax++;
        continue;
      }
      if (seen.has(email)) {
        report.duplicates_in_file++;
        continue;
      }
      seen.add(email);
      report.valid++;
      batch.push({
        row: rowNo,
        email,
        createdAt: columns.createdAt != null ? parseCreated(rec[columns.createdAt]) : null,
        interests: rowInterests(
          {
            interests: columns.interests != null ? rec[columns.interests] : undefined,
            lists: columns.lists != null ? rec[columns.lists] : undefined,
          },
          defaults,
        ),
      });
      if (batch.length >= BATCH) {
        await this.processBatch(batch, input, target, imp!.id, filename, sha256, consentSource, threshold, report);
        batch = [];
      }
    }
    if (batch.length) await this.processBatch(batch, input, target, imp!.id, filename, sha256, consentSource, threshold, report);

    await db
      .update(emailImports)
      .set({
        rowCount: report.rows_read,
        created: report.created ?? 0,
        updated: report.updated ?? 0,
        skipped: report.skipped ?? 0,
        evidencePath,
        report: report as unknown as Record<string, unknown>,
      })
      .where(eq(emailImports.id, imp!.id));
    return report;
  }

  private async processBatch(
    rows: ParsedRow[],
    input: RunImportInput,
    target: Target,
    importId: string,
    filename: string,
    sha256: string,
    consentSource: string,
    threshold: number,
    report: ImportReport,
  ): Promise<void> {
    const db = getDb();
    const emails = rows.map((r) => r.email);
    const existing = new Map<string, Contact>(
      (await db.select().from(emailContacts).where(inArray(emailContacts.email, emails))).map((c) => [c.email, c]),
    );
    const customerByEmail = new Map<string, string>();
    for (const c of await db
      .select({ id: customers.id, email: sql<string>`lower(btrim(${customers.email}))` })
      .from(customers)
      .where(and(isNull(customers.deletedAt), inArray(sql`lower(btrim(${customers.email}))`, emails)))
      .orderBy(customers.createdAt)) {
      if (!customerByEmail.has(c.email)) customerByEmail.set(c.email, c.id);
    }

    const conflict = (c: Conflict) => {
      if (report.conflicts.length < 50) report.conflicts.push({ ...c, email: maskEmail(c.email) });
    };

    await db.transaction(async (tx) => {
      for (const r of rows) {
        const evidence = { import_id: importId, row: r.row, filename, sha256 };
        const current = existing.get(r.email);
        const customerId = customerByEmail.get(r.email);

        if (!current) {
          report.would_create++;
          if (customerId) report.linked_customers++;
          if (input.dryRun) continue;
          const now = new Date();
          const interests: InterestMap = r.interests.length ? addInterestPoints({}, r.interests, threshold, now) : {};
          const { contact } = await this.contacts.findOrCreateByEmail(
            r.email,
            {
              source: consentSource,
              actor: input.actor,
              initialStatus: target.status,
              consentAt: target.status === 'all' ? (r.createdAt ?? now) : null,
              evidence,
              customerId: customerId ?? null,
              interests,
            },
            tx,
          );
          if (target.deliverability) {
            await this.contacts.recordDeliverability(contact.id, target.deliverability, now, 30, tx);
          }
          if (customerId) {
            await tx.update(customers).set({ contactId: contact.id }).where(and(eq(customers.id, customerId), isNull(customers.contactId)));
          }
          report.created!++;
          continue;
        }

        report.already_present++;
        const willLink = Boolean(customerId && !current.customerId);
        const statusChange = RANK[target.status] < RANK[current.marketingStatus] && current.marketingStatus !== 'never';
        const deliverabilityChange =
          target.deliverability !== null &&
          current.deliverability !== target.deliverability &&
          // A complaint is the strongest signal; a bounce never replaces it.
          current.deliverability !== 'complained';

        if (current.marketingStatus === 'never' && target.status !== 'never') {
          conflict({ row: r.row, email: r.email, kind: 'never_unchanged', from: 'never', to: target.status });
        } else if (RANK[target.status] > RANK[current.marketingStatus]) {
          report.would_upgrade_refused++;
          conflict({ row: r.row, email: r.email, kind: 'would_upgrade_refused', from: current.marketingStatus, to: target.status });
        } else if (statusChange) {
          report.would_downgrade++;
          conflict({ row: r.row, email: r.email, kind: 'would_downgrade', from: current.marketingStatus, to: target.status });
        }

        // A `never` contact is never changed by an import, not even its
        // deliverability: the operator who set it owns it.
        const changes = current.marketingStatus !== 'never' && (statusChange || deliverabilityChange || willLink);
        if (!changes) {
          if (!input.dryRun) report.skipped!++;
          continue;
        }
        report.would_update++;
        if (input.dryRun) continue;

        if (statusChange) {
          await this.contacts.setMarketingStatus(
            current.id,
            target.status,
            { source: 'csv_import', actor: input.actor, reason: `${input.listType} import`, evidence },
            tx,
          );
        }
        if (deliverabilityChange) {
          await this.contacts.recordDeliverability(current.id, target.deliverability!, new Date(), 30, tx);
        }
        if (willLink) {
          await tx.update(emailContacts).set({ customerId }).where(eq(emailContacts.id, current.id));
          await tx.update(customers).set({ contactId: current.id }).where(and(eq(customers.id, customerId!), isNull(customers.contactId)));
          report.linked_customers++;
        }
        report.updated!++;
      }
    });
  }
}

/** All material interest keys — the lights-out default for a contacts import. */
export const ALL_MATERIAL_INTERESTS = MATERIAL_KEYS;
