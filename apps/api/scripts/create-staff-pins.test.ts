/**
 * Named staff PINs. What matters:
 *
 *  - a PIN is never the same as any ACTIVE PIN — `pin-login` without a site
 *    takes the first hash that verifies, so a shared PIN signs someone in as
 *    somebody else;
 *  - re-running never replaces a PIN already handed over;
 *  - extra venues become ADMIN grants head office can see and revoke;
 *  - a dry run issues nothing, and a bad list writes nothing at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { devicePins, devicePinSites, sites } from '../src/db/schema/index.js';
import { hashPassword, verifyPassword } from '../src/shared/auth/password.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { seedSites } from './seed-sites.js';
import { createStaffPins, parseStaffList } from './create-staff-pins.js';

const NAMES = ['Test Baker One', 'Test Baker Two', 'Test Manager'];

async function cleanUp() {
  await getDb().delete(devicePins).where(inArray(devicePins.label, NAMES));
}

describe('parseStaffList', () => {
  it('reads name, venues (first is home) and an optional role', () => {
    const list = parseStaffList(
      '# a comment\n\nEloise Frank, Birmingham\nJonas Gottschalk, Manchester; Liverpool, site_manager\n',
    );
    expect(list).toEqual([
      {
        line: 3,
        name: 'Eloise Frank',
        venues: ['Birmingham'],
        role: 'head_baker',
      },
      {
        line: 4,
        name: 'Jonas Gottschalk',
        venues: ['Manchester', 'Liverpool'],
        role: 'site_manager',
      },
    ]);
  });

  it('refuses the whole list over one bad line, naming every problem', () => {
    expect(() => parseStaffList('A Person\nB Person, Liverpool, admin\nB Person, Liverpool')).toThrow(
      /line 1: no venue[\s\S]*line 2: role "admin"[\s\S]*line 3: "B Person" is also on line 2/,
    );
  });
});

describe('createStaffPins', () => {
  beforeEach(async () => {
    await seedSites();
    await cleanUp();
  });
  afterAll(async () => {
    await cleanUp();
    await closeDatabase();
  });

  const list = () =>
    parseStaffList(
      'Test Baker One, Birmingham\nTest Baker Two, London East; London South\nTest Manager, manchester, site_manager',
    );

  it('a dry run issues no PIN and writes nothing', async () => {
    const res = await createStaffPins(list());
    expect(res.map((r) => r.status)).toEqual(['would-create', 'would-create', 'would-create']);
    expect(res.every((r) => r.pin === undefined)).toBe(true);
    const rows = await getDb().select().from(devicePins).where(inArray(devicePins.label, NAMES));
    expect(rows).toHaveLength(0);
  });

  it('creates a distinct PIN per person, home venue plus ADMIN grants for the extras', async () => {
    const res = await createStaffPins(list(), { apply: true });
    const pins = res.map((r) => r.pin!);
    expect(new Set(pins).size).toBe(3);
    for (const p of pins) expect(p).toMatch(/^[1-9]\d{5}$/);

    const db = getDb();
    const two = await db.query.devicePins.findFirst({
      where: eq(devicePins.label, 'Test Baker Two'),
    });
    const east = await db.query.sites.findFirst({
      where: eq(sites.slug, 'london-east'),
    });
    const south = await db.query.sites.findFirst({
      where: eq(sites.slug, 'london-south'),
    });
    expect(two!.siteId).toBe(east!.id);
    expect(two!.roles).toEqual(['head_baker']);
    expect(await verifyPassword(pins[1]!, two!.pinHash)).toBe(true);
    const grants = await db.select().from(devicePinSites).where(eq(devicePinSites.devicePinId, two!.id));
    expect(grants).toMatchObject([{ siteId: south!.id, addedVia: 'ADMIN' }]);

    const manager = await db.query.devicePins.findFirst({
      where: eq(devicePins.label, 'Test Manager'),
    });
    expect(manager!.roles).toEqual(['site_manager']);
  });

  it('never matches an active PIN, and a re-run leaves handed-over PINs alone', async () => {
    const first = await createStaffPins(list(), { apply: true });
    const again = await createStaffPins(list(), { apply: true });
    expect(again.map((r) => r.status)).toEqual(['exists', 'exists', 'exists']);
    expect(again.every((r) => r.pin === undefined)).toBe(true);

    // Every active PIN in the database, verified against the three issued: a
    // match on any row but the person's own would sign them in as someone else.
    const active = await getDb().query.devicePins.findMany({
      where: eq(devicePins.isActive, true),
    });
    for (const r of first) {
      const matches = [];
      for (const row of active) if (await verifyPassword(r.pin!, row.pinHash)) matches.push(row.label);
      expect(matches).toEqual([r.name]);
    }
  });

  it('an existing PIN keeps its value and home, and gains only the venues it lacked', async () => {
    // As found live: a person already set up at one venue, listed for two.
    const db = getDb();
    const south = await db.query.sites.findFirst({ where: eq(sites.slug, 'london-south') });
    const east = await db.query.sites.findFirst({ where: eq(sites.slug, 'london-east') });
    const [pre] = await db
      .insert(devicePins)
      .values({
        companyId: getSingletonCompanyId(),
        label: 'Test Baker Two',
        siteId: south!.id,
        pinHash: await hashPassword('314159'),
      })
      .returning();

    const dry = await createStaffPins(parseStaffList('Test Baker Two, London East; London South'));
    // The venues it REALLY has, home first, and what the list would add.
    expect(dry[0]).toMatchObject({
      status: 'exists',
      venues: ['London South'],
      venuesToAdd: ['London East'],
    });
    expect(dry[0]!.note).toMatch(/London South by default, not London East/);
    expect(
      await db.select().from(devicePinSites).where(eq(devicePinSites.devicePinId, pre!.id)),
    ).toHaveLength(0);

    await createStaffPins(parseStaffList('Test Baker Two, London East; London South'), { apply: true });
    const after = await db.query.devicePins.findFirst({ where: eq(devicePins.id, pre!.id) });
    expect(after!.siteId).toBe(south!.id);
    expect(await verifyPassword('314159', after!.pinHash)).toBe(true);
    const grants = await db.select().from(devicePinSites).where(eq(devicePinSites.devicePinId, pre!.id));
    expect(grants).toMatchObject([{ siteId: east!.id, addedVia: 'ADMIN' }]);

    const again = await createStaffPins(parseStaffList('Test Baker Two, London East; London South'), {
      apply: true,
    });
    expect(again[0]).toMatchObject({ venues: ['London South', 'London East'], venuesToAdd: [] });
  });

  it('--replace-existing re-PINs the same row: the old PIN stops, venues and identity stay', async () => {
    const [first] = await createStaffPins(parseStaffList('Test Baker Two, London East; London South'), {
      apply: true,
    });
    const db = getDb();
    const before = await db.query.devicePins.findFirst({ where: eq(devicePins.label, 'Test Baker Two') });

    const dry = await createStaffPins(parseStaffList('Test Baker Two, London East; London South'), {
      replaceExisting: true,
    });
    expect(dry[0]).toMatchObject({ status: 'would-replace' });
    expect(dry[0]!.pin).toBeUndefined();
    const untouched = await db.query.devicePins.findFirst({ where: eq(devicePins.id, before!.id) });
    expect(await verifyPassword(first!.pin!, untouched!.pinHash)).toBe(true);

    const [re] = await createStaffPins(parseStaffList('Test Baker Two, London East; London South'), {
      apply: true,
      replaceExisting: true,
    });
    expect(re).toMatchObject({ status: 'replaced', venues: ['London East', 'London South'] });
    expect(re!.pin).toMatch(/^[1-9]\d{5}$/);
    expect(re!.pin).not.toBe(first!.pin);

    const rows = await db.select().from(devicePins).where(eq(devicePins.label, 'Test Baker Two'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(await verifyPassword(re!.pin!, rows[0]!.pinHash)).toBe(true);
    expect(await verifyPassword(first!.pin!, rows[0]!.pinHash)).toBe(false);
    const grants = await db.select().from(devicePinSites).where(eq(devicePinSites.devicePinId, before!.id));
    expect(grants).toHaveLength(1);
  });

  it('refuses a name that two active PINs share, writing nothing', async () => {
    const db = getDb();
    for (const pin of ['271828', '161803']) {
      await db.insert(devicePins).values({
        companyId: getSingletonCompanyId(),
        label: 'Test Manager',
        pinHash: await hashPassword(pin),
      });
    }
    await expect(
      createStaffPins(parseStaffList('Test Baker One, Birmingham\nTest Manager, Manchester'), {
        apply: true,
        replaceExisting: true,
      }),
    ).rejects.toThrow(/more than one active PIN is called "Test Manager"/);
    expect(await db.select().from(devicePins).where(eq(devicePins.label, 'Test Baker One'))).toHaveLength(0);
  });

  it('an unknown venue writes nothing for anyone', async () => {
    await expect(
      createStaffPins(parseStaffList('Test Baker One, Birmingham\nTest Baker Two, Leeds'), { apply: true }),
    ).rejects.toThrow(/no venue called "Leeds"/);
    const rows = await getDb().select().from(devicePins).where(inArray(devicePins.label, NAMES));
    expect(rows).toHaveLength(0);
  });
});
