/**
 * The dashboard's contract is that a section which cannot answer says so and
 * the others still render. The page this replaced failed exactly here: four
 * parallel fetches, a catch on only three, so one unconfigured integration
 * blanked everything with "Failed to load dashboard data."
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { DashboardService, previousDay } from './dashboard.service.js';

const COMPANY = getSingletonCompanyId();

describe('previousDay', () => {
  it('returns the day before, ISO-formatted', () => {
    expect(previousDay(new Date('2026-07-27T09:00:00Z'))).toBe('2026-07-26');
  });

  it('crosses a month boundary', () => {
    expect(previousDay(new Date('2026-03-01T00:30:00Z'))).toBe('2026-02-28');
  });
});

describe('DashboardService.overview', () => {
  beforeAll(() => {
    // The BumbleBee base URL is unset in the test env, which is the case the
    // sessions tile has to survive.
    delete process.env.BUMBLEBEE_API_BASE_URL;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('reports the sessions tile as unavailable rather than throwing', async () => {
    const data = await new DashboardService().overview(COMPANY);
    expect(data.sessions.available).toBe(false);
    expect(data.sessions.reason).toMatch(/BUMBLEBEE_API_BASE_URL/);
    expect(data.sessions.rows).toEqual([]);
  });

  it('still returns the other sections when BumbleBee is unconfigured', async () => {
    const data = await new DashboardService().overview(COMPANY);
    // The whole point: one dead integration must not take the page with it.
    expect(data.stock.available).toBe(true);
    expect(data.reorder.available).toBe(true);
    expect(Array.isArray(data.sites)).toBe(true);
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('explains an empty stock tile instead of implying zero stock is normal', async () => {
    const data = await new DashboardService().overview(COMPANY);
    if (data.stock.rows.length === 0) {
      expect(data.stock.reason).toBeTruthy();
    }
  });

  it('honours an explicit date', async () => {
    const data = await new DashboardService().overview(COMPANY, '2026-01-15');
    expect(data.date).toBe('2026-01-15');
  });
});
