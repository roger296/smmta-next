/**
 * BumbleBee session poll (P16, spec §A6).
 *
 * The head-baker form lists the site's sessions for the day, polled from
 * BumbleBee. BumbleBee is the source of sessions + covers.
 *
 * Wire format is BumbleBee's `GET /api/v1/sessions` (bakes-core
 * `services/queries.py::query_sessions`), which:
 *   - filters by `date_from`/`date_to` (there is NO `date` param — an unknown
 *     query param is ignored by FastAPI, so sending `date` silently returns
 *     every session for the site);
 *   - returns `{rows: [...], total_count, next_offset}` — not `{data: [...]}`;
 *   - names the key `id`, not `sessionId`, and gives `start` as a full ISO
 *     timestamp rather than a date.
 * Getting any of those wrong yields "0 sessions everywhere" rather than an
 * error, which is why this client is pinned to the shapes above and tested
 * against them.
 *
 * Covers come from `GET /api/v1/orders` (`pax`, summed per session): the
 * sessions endpoint carries `capacity`, which is how many the session could
 * hold, not how many booked.
 *
 * Unconfigured (no base URL) returns [] so the dashboard and MCP tool degrade
 * gracefully. A configured-but-failing BumbleBee throws, so callers can report
 * "could not reach BumbleBee" instead of the indistinguishable "no sessions".
 */
import { getEnv } from '../../config/env.js';
import { ExpectedConsumptionService, type SessionLine } from '../recipes/expected-consumption.service.js';

export interface BumbleBeeSession {
  sessionId: string;
  siteCanonicalName?: string;
  sessionDate?: string;
  /** Order lines. Only set by callers that already hold them — BumbleBee's
   *  sessions endpoint does not return line items. */
  lines?: SessionLine[];
}

export interface DaySession {
  sessionId: string;
  sessionDate: string;
  /** Guest count. The cake baked isn't on the booking — the head-baker picks
   *  it on the form. */
  covers: number;
}

/** A row of BumbleBee's `GET /api/v1/sessions`. */
interface SessionRowWire {
  id: string;
  site: string | null;
  start: string | null;
}

/** A row of BumbleBee's `GET /api/v1/orders`. */
interface OrderRowWire {
  session_id: string | null;
  pax: number | null;
}

export class BumbleBeeSessionClient {
  private expected = new ExpectedConsumptionService();

  /**
   * Sessions for a site + date, with covers.
   *
   * @throws if BumbleBee is configured but does not answer — a bad API key
   *         must not read as a quiet day.
   */
  async listSessionsForDay(params: {
    siteCanonicalName: string;
    date: string;
    companyId?: string;
  }): Promise<DaySession[]> {
    const env = getEnv();
    if (!env.BUMBLEBEE_API_BASE_URL) return [];

    // EVENT only. BumbleBee's other session type, CAFE_BAR, is a synthetic
    // 08:00–22:00 container the Square sweeper creates per site per day to hold
    // till takings — no bake leader, no cake, no consumption statement. Leaving
    // it in would park one permanently-unfileable row on every site, so the
    // "missing" badge would never clear and would stop meaning anything.
    const rows = await this.get<SessionRowWire>('/api/v1/sessions', params, {
      session_type: 'EVENT',
    });
    if (rows.length === 0) return [];

    const covers = await this.coversBySession(params);
    return rows.map((r) => ({
      sessionId: r.id,
      sessionDate: (r.start ?? params.date).slice(0, 10),
      covers: covers.get(r.id) ?? 0,
    }));
  }

  /**
   * Covers per session, summed from order `pax`.
   *
   * Best-effort: covers are secondary to knowing a session happened, so a
   * failure here leaves them at 0 rather than hiding the sessions themselves.
   */
  private async coversBySession(params: {
    siteCanonicalName: string;
    date: string;
  }): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      for (const o of await this.get<OrderRowWire>('/api/v1/orders', params)) {
        if (!o.session_id) continue;
        out.set(o.session_id, (out.get(o.session_id) ?? 0) + (o.pax ?? 0));
      }
    } catch {
      // Leave covers at 0.
    }
    return out;
  }

  private async get<T>(
    path: string,
    params: { siteCanonicalName: string; date: string },
    extra: Record<string, string> = {},
  ): Promise<T[]> {
    const env = getEnv();
    const url = new URL(path, env.BUMBLEBEE_API_BASE_URL);
    url.searchParams.set('site', params.siteCanonicalName);
    url.searchParams.set('date_from', params.date);
    url.searchParams.set('date_to', params.date);
    url.searchParams.set('limit', '200');
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: env.BUMBLEBEE_API_KEY ? { Authorization: `Bearer ${env.BUMBLEBEE_API_KEY}` } : {},
    });
    if (!res.ok) {
      throw new Error(
        `BumbleBee ${path} returned ${res.status}` +
          (res.status === 401 ? ' — check BUMBLEBEE_API_KEY' : ''),
      );
    }
    const body = (await res.json()) as { rows?: T[] };
    return body.rows ?? [];
  }

  /** Resolve covers from order lines a caller already holds. */
  async toDaySession(
    s: BumbleBeeSession,
    fallbackDate: string,
    companyId?: string,
  ): Promise<DaySession> {
    const covers = s.lines?.length ? await this.expected.resolveCovers(s.lines, companyId) : 0;
    return { sessionId: s.sessionId, sessionDate: s.sessionDate ?? fallbackDate, covers };
  }
}
