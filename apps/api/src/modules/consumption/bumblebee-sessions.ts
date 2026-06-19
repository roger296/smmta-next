/**
 * BumbleBee session poll (P16, spec §A6).
 *
 * The head-baker form lists the site's sessions for the day, polled from
 * BumbleBee. BumbleBee is the source of sessions + covers; Auto-Stock resolves
 * each session's experience from the Tonic product on its order lines
 * (`products.experience_type`). This client is guarded: with no BumbleBee base
 * URL configured it returns [] (the live endpoint is a go-live step), so the
 * dashboard / MCP tool degrade gracefully rather than throwing.
 */
import { getEnv } from '../../config/env.js';
import { ExpectedConsumptionService, type SessionLine } from '../recipes/expected-consumption.service.js';

export interface BumbleBeeSession {
  sessionId: string;
  siteCanonicalName?: string;
  sessionDate?: string;
  /** Order lines, used to sum covers (guest count). */
  lines?: SessionLine[];
}

export interface DaySession {
  sessionId: string;
  sessionDate: string;
  /** Guest count summed from the experience-booking order lines. The cake
   *  baked isn't on the booking — the head-baker picks it on the form. */
  covers: number;
}

export class BumbleBeeSessionClient {
  private expected = new ExpectedConsumptionService();

  /**
   * Sessions for a site + date with resolved cover-groups. Returns [] when no
   * BumbleBee base URL is configured (the default in the build).
   */
  async listSessionsForDay(params: {
    siteCanonicalName: string;
    date: string;
    companyId?: string;
  }): Promise<DaySession[]> {
    const env = getEnv();
    if (!env.BUMBLEBEE_API_BASE_URL) return [];
    const url = new URL('/api/v1/sessions', env.BUMBLEBEE_API_BASE_URL);
    url.searchParams.set('site', params.siteCanonicalName);
    url.searchParams.set('date', params.date);
    const res = await fetch(url, {
      headers: env.BUMBLEBEE_API_KEY ? { Authorization: `Bearer ${env.BUMBLEBEE_API_KEY}` } : {},
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: BumbleBeeSession[] };
    const sessions = body.data ?? [];
    return Promise.all(sessions.map((s) => this.toDaySession(s, params.date, params.companyId)));
  }

  private async toDaySession(
    s: BumbleBeeSession,
    fallbackDate: string,
    companyId?: string,
  ): Promise<DaySession> {
    const covers = s.lines?.length ? await this.expected.resolveCovers(s.lines, companyId) : 0;
    return { sessionId: s.sessionId, sessionDate: s.sessionDate ?? fallbackDate, covers };
  }
}
