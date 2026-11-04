/**
 * CSV importer (runbook section 4): header detection on six layouts, the
 * four-file sequence, idempotency and the dry-run requirement.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import { getDb } from '../../../config/database.js';
import { resetEnvForTests } from '../../../config/env.js';
import { customers, emailConsentEvents, emailContacts } from '../../../db/schema/index.js';
import { ContactsService } from './contacts.service.js';
import { detectColumns, ImportRefusedError, ImportsService, parseCreated, rowInterests } from './imports.service.js';
import { cleanupFixtures, makeContact, makeCustomer, uniqueEmail } from '../testing.js';

const FIXTURES = resolve(process.cwd(), 'test/fixtures/email/sendgrid');
const headersOf = (file: string) => (parse(readFileSync(join(FIXTURES, file)), { bom: true, to_line: 1 }) as string[][])[0]!;

describe('detectColumns — six layouts', () => {
  it('SendGrid marketing contacts export', () => {
    const c = detectColumns(headersOf('contacts-export.csv'))!;
    expect(c.headers[c.email]).toBe('EMAIL');
    expect(c.headers[c.createdAt!]).toBe('CREATED_AT');
    expect(c.lists).toBeNull();
  });
  it('SendGrid suppression exports (bounces, spam reports, unsubscribes)', () => {
    for (const f of ['bounces-export.csv', 'spam-reports-export.csv', 'unsubscribes-export.csv']) {
      const c = detectColumns(headersOf(f))!;
      expect(c.headers[c.email]).toBe('email');
      expect(c.headers[c.createdAt!]).toBe('created');
    }
  });
  it('a bare email column', () => {
    const c = detectColumns(headersOf('bare.csv'))!;
    expect(c.email).toBe(0);
    expect(c.createdAt).toBeNull();
  });
  it('a layout with list names and other spellings', () => {
    const c = detectColumns(headersOf('with-lists.csv'))!;
    expect(c.headers[c.email]).toBe('Email Address');
    expect(c.headers[c.lists!]).toBe('list_names');
    expect(c.headers[c.createdAt!]).toBe('Date Added');
  });
  it('a byte-order mark and CRLF line endings', () => {
    const c = detectColumns(headersOf('bom-crlf.csv'))!;
    expect(c.headers[c.email]).toBe('email');
    expect(c.headers[c.createdAt!]).toBe('created_at');
  });
  it('ignores LIST_IDS with no names column, and returns null with no email column', () => {
    expect(detectColumns(['EMAIL', 'LIST_IDS'])!.lists).toBeNull();
    expect(detectColumns(headersOf('unknown-layout.csv'))).toBeNull();
  });
});

describe('row helpers', () => {
  it('parses unix seconds, ISO and plain dates', () => {
    expect(parseCreated('1709287200')!.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    expect(parseCreated('2024-01-05 09:00:00')!.toISOString()).toBe('2024-01-05T09:00:00.000Z');
    expect(parseCreated('2024-03-01T10:00:00Z')!.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    expect(parseCreated('rubbish')).toBeNull();
    expect(parseCreated('')).toBeNull();
  });
  it('maps interests: column, then list names, then defaults', () => {
    expect(rowInterests({ interests: 'pla; material:petg' }, ['material:abs'])).toEqual(['material:pla', 'material:petg']);
    expect(rowInterests({ lists: 'PETG fans; ABS & ASA' }, ['material:tpu'])).toEqual(['material:petg', 'material:abs', 'material:asa']);
    expect(rowInterests({ lists: 'General newsletter' }, ['material:tpu'])).toEqual(['material:tpu']);
    expect(rowInterests({}, [])).toEqual([]);
  });
});

describe('ImportsService', () => {
  const svc = new ImportsService();
  const contacts = new ContactsService();
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'email-import-'));
    vi.stubEnv('EMAIL_EVIDENCE_DIR', join(dir, 'evidence'));
    resetEnvForTests();
  });
  afterEach(() => undefined);
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvForTests();
    await cleanupFixtures();
  });

  const file = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  async function run(listType: 'bounces' | 'spam_reports' | 'unsubscribes' | 'contacts', path: string) {
    const dry = await svc.run({ filePath: path, listType, dryRun: true, actor: 'test', defaultInterests: ['material:pla'] });
    const live = await svc.run({ filePath: path, listType, dryRun: false, dryRunId: dry.importId, actor: 'test', defaultInterests: ['material:pla'] });
    return { dry, live };
  }

  it('applies the four files in order so the most restrictive result wins', async () => {
    const inAll = uniqueEmail('imp-all');
    const unsubAndContact = uniqueEmail('imp-uc');
    const onlyContact = uniqueEmail('imp-c');
    const neverOne = (await makeContact({ initialStatus: 'never' })).email;
    const customerEmail = uniqueEmail('imp-cust');
    const customer = await makeCustomer(customerEmail);

    const bounces = file('b.csv', `email,created,reason\n${inAll},1709287200,550\n`);
    const spam = file('s.csv', `email,created\n${inAll},1709287200\n`);
    const unsubs = file('u.csv', `email,created\n${inAll},1709287200\n${unsubAndContact},1709287200\n${neverOne},1709287200\n`);
    const contactsCsv = file(
      'c.csv',
      `EMAIL,FIRST_NAME,CREATED_AT\n${inAll},A,2024-01-01T00:00:00Z\n${unsubAndContact},B,2024-01-01T00:00:00Z\n${onlyContact},C,2024-02-03T04:05:06Z\n${neverOne},D,2024-01-01T00:00:00Z\n${customerEmail.toUpperCase()},E,2024-01-01T00:00:00Z\nnot-an-email,F,2024-01-01\n${onlyContact},G,2024-01-01\n`,
    );

    await run('bounces', bounces);
    await run('spam_reports', spam);
    await run('unsubscribes', unsubs);
    const c = await run('contacts', contactsCsv);

    expect(c.dry).toMatchObject({ rows_read: 7, valid: 5, invalid_syntax: 1, duplicates_in_file: 1, would_create: 2, already_present: 3, would_upgrade_refused: 2 });
    expect(c.dry.conflicts.map((x) => x.kind).sort()).toEqual(['never_unchanged', 'would_upgrade_refused', 'would_upgrade_refused']);
    expect(c.dry.conflicts[0]!.email).toContain('***@example.com');

    const all = (await contacts.getByEmail(inAll))!;
    expect(all).toMatchObject({ deliverability: 'complained', marketingStatus: 'transactional_only' });
    expect((await contacts.getByEmail(unsubAndContact))!.marketingStatus).toBe('transactional_only');
    const only = (await contacts.getByEmail(onlyContact))!;
    expect(only.marketingStatus).toBe('all');
    expect(only.consentSource).toBe('sendgrid_import');
    expect(only.consentAt!.toISOString()).toBe('2024-02-03T04:05:06.000Z');
    expect(only.consentEvidence).toMatchObject({ import_id: c.live.importId, row: 4, filename: 'c.csv' });
    expect(only.interests['material:pla']!.score).toBe(3);
    expect((await contacts.getByEmail(neverOne))!.marketingStatus).toBe('never');

    const linked = (await contacts.getByEmail(customerEmail))!;
    expect(linked.customerId).toBe(customer.id);
    const [cust] = await getDb().select().from(customers).where(eq(customers.id, customer.id));
    expect(cust!.contactId).toBe(linked.id);
    const dupes = await getDb().select().from(emailContacts).where(eq(emailContacts.email, customerEmail));
    expect(dupes).toHaveLength(1);

    // The unsubscribe import wrote a consent event with the import evidence.
    const ev = await getDb().select().from(emailConsentEvents).where(eq(emailConsentEvents.contactId, all.id));
    expect(ev.map((e) => e.source)).toEqual(['sendgrid_import']);
  });

  it('downgrades an existing marketing contact and records the import as evidence', async () => {
    const c = await makeContact({ initialStatus: 'all' });
    const p = file('u2.csv', `email\n${c.email}\n`);
    const { dry, live } = await run('unsubscribes', p);
    expect(dry.would_downgrade).toBe(1);
    expect(live.updated).toBe(1);
    expect((await contacts.get(c.id))!.marketingStatus).toBe('transactional_only');
    const ev = await getDb().select().from(emailConsentEvents).where(inArray(emailConsentEvents.contactId, [c.id]));
    expect(ev.at(-1)).toMatchObject({ source: 'csv_import', evidence: { import_id: live.importId, row: 2 } });
  });

  it('treats a re-run of an imported file as a no-op', async () => {
    const e = uniqueEmail('imp-rerun');
    const p = file('r.csv', `email\n${e}\n`);
    const first = await run('unsubscribes', p);
    expect(first.live.created).toBe(1);
    const again = await run('unsubscribes', p);
    expect(again.live.already_imported).toBe(true);
    expect(again.live.created).toBe(0);
  });

  it('refuses a live run without a matching dry run', async () => {
    const p = file('x.csv', `email\n${uniqueEmail('imp-x')}\n`);
    await expect(svc.run({ filePath: p, listType: 'unsubscribes', dryRun: false, actor: 't' })).rejects.toMatchObject({ code: 'dry_run_required' });
    const dry = await svc.run({ filePath: p, listType: 'unsubscribes', dryRun: true, actor: 't' });
    writeFileSync(p, `email\n${uniqueEmail('imp-changed')}\n`);
    await expect(svc.run({ filePath: p, listType: 'unsubscribes', dryRun: false, dryRunId: dry.importId, actor: 't' })).rejects.toMatchObject({ code: 'dry_run_mismatch' });
    const other = file('y.csv', readFileSync(p));
    const dry2 = await svc.run({ filePath: other, listType: 'unsubscribes', dryRun: true, actor: 't' });
    await expect(svc.run({ filePath: other, listType: 'bounces', dryRun: false, dryRunId: dry2.importId, actor: 't' })).rejects.toMatchObject({ code: 'dry_run_mismatch' });
  });

  it('stops on an unknown layout and lists the headers', async () => {
    await expect(svc.run({ filePath: join(FIXTURES, 'unknown-layout.csv'), listType: 'contacts', dryRun: true, actor: 't' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ImportRefusedError && e.code === 'unknown_layout' && e.message.includes('name, phone'),
    );
  });

  it('keeps a copy of a live-imported file in the evidence store', async () => {
    const p = file('ev.csv', `email\n${uniqueEmail('imp-ev')}\n`);
    const { live } = await run('unsubscribes', p);
    const row = await svc.get(live.importId!);
    expect(row!.evidencePath).toContain(live.sha256);
    expect(readFileSync(row!.evidencePath!, 'utf8')).toBe(readFileSync(p, 'utf8'));
  });
});
