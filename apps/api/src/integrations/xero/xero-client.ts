/**
 * Xero API client (spec §A8) — mirrors the integrations/luca/ layout.
 *
 * App credentials (client id/secret) come from env; the per-org OAuth token
 * state (access/refresh/expiry) lives AES-encrypted in `xero_connections` and
 * is refreshed on demand (Xero rotates the refresh token on every refresh, so
 * the new pair is written straight back). The GL service only constructs /
 * calls the client when NOT in dry-run, so an unconfigured deployment never
 * reaches the network.
 */
import { eq, and } from 'drizzle-orm';
import { getEnv } from '../../config/env.js';
import { getDb } from '../../config/database.js';
import { xeroConnections } from '../../db/schema/index.js';
import { decrypt, encrypt } from '../../shared/crypto/encrypt.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import type { XeroManualJournal, XeroPostResult } from './xero-types.js';

const TOKEN_URL = 'https://identity.xero.com/connect/token';

export class XeroApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'XeroApiError';
  }
}

export class XeroNotConfiguredError extends Error {
  constructor(message = 'Xero is not configured (no client credentials or stored connection)') {
    super(message);
    this.name = 'XeroNotConfiguredError';
  }
}

export class XeroClient {
  constructor(
    private accessToken: string,
    private readonly tenantId: string,
    private readonly baseUrl = getEnv().XERO_API_BASE_URL,
  ) {}

  /**
   * Build a client from env app-creds + the stored connection, refreshing the
   * token if it has expired. Returns null when Xero isn't configured (no app
   * creds, or no stored connection) so callers can degrade to dry-run.
   */
  static async fromConnection(companyId = getSingletonCompanyId()): Promise<XeroClient | null> {
    const env = getEnv();
    if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) return null;
    const db = getDb();
    const conn = await db.query.xeroConnections.findFirst({
      where: env.XERO_TENANT_ID
        ? and(
            eq(xeroConnections.companyId, companyId),
            eq(xeroConnections.tenantId, env.XERO_TENANT_ID),
          )
        : eq(xeroConnections.companyId, companyId),
    });
    if (!conn || !conn.accessTokenEnc || !conn.refreshTokenEnc) return null;

    let accessToken = decrypt(conn.accessTokenEnc);
    const expired = !conn.expiresAt || conn.expiresAt.getTime() <= Date.now() + 60_000;
    if (expired) {
      accessToken = await XeroClient.refresh(companyId, conn.id, decrypt(conn.refreshTokenEnc));
    }
    return new XeroClient(accessToken, conn.tenantId);
  }

  /** Exchange the rotating refresh token for a fresh access token, persisting
   *  the new (rotated) pair. Returns the new access token. */
  private static async refresh(
    companyId: string,
    connId: string,
    refreshToken: string,
  ): Promise<string> {
    const env = getEnv();
    const basic = Buffer.from(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!res.ok) {
      throw new XeroApiError(`Xero token refresh failed: ${res.status}`, res.status, await res.text());
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const expiresAt = new Date(Date.now() + json.expires_in * 1000);
    await getDb()
      .update(xeroConnections)
      .set({
        accessTokenEnc: encrypt(json.access_token),
        refreshTokenEnc: encrypt(json.refresh_token),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(xeroConnections.id, connId));
    void companyId;
    return json.access_token;
  }

  /** POST a balanced manual journal to Xero. Returns the ManualJournalID. */
  async postManualJournal(journal: XeroManualJournal): Promise<XeroPostResult> {
    const body = {
      ManualJournals: [
        {
          Narration: journal.narration,
          Date: journal.date,
          Status: journal.status,
          ...(journal.reference ? { /* Xero journals have no reference field; carry it in narration */ } : {}),
          JournalLines: journal.journalLines.map((l) => ({
            LineAmount: l.lineAmount,
            AccountCode: l.accountCode,
            ...(l.taxType ? { TaxType: l.taxType } : {}),
            ...(l.description ? { Description: l.description } : {}),
          })),
        },
      ],
    };
    const res = await fetch(`${this.baseUrl}/ManualJournals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Xero-Tenant-Id': this.tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new XeroApiError(`Xero ManualJournals POST ${res.status}`, res.status, await res.text());
    }
    const json = (await res.json()) as { ManualJournals?: Array<{ ManualJournalID: string }> };
    const id = json.ManualJournals?.[0]?.ManualJournalID;
    if (!id) throw new XeroApiError('Xero response missing ManualJournalID', 200, json);
    return { manualJournalId: id };
  }
}
