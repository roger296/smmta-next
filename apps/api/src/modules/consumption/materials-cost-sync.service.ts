/**
 * Materials-cost → BumbleBee sync (P17, spec §A8).
 *
 * Pushes a session's true materials cost (Σ actual × unit cost) to BumbleBee so
 * it lands in profit reporting. Guarded + dry-run by default: with
 * MATERIALS_COST_SYNC off or no BumbleBee base URL, it records the intended
 * payload (dry-run) and sends nothing — the BumbleBee write endpoint is a
 * follow-up. Idempotent on BumbleBee's convention
 * (source_system='autostock', source_key=session_id, content_hash): re-pushing
 * the same cost is a no-op; an amended cost (new hash) pushes again.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { bumblebeeSyncLog, sessionConsumption } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const SOURCE_SYSTEM = 'autostock';

export interface SyncResult {
  /** false ⇒ no consumption record for the session. */
  found: boolean;
  /** true ⇒ this exact cost was already synced (no-op). */
  idempotent: boolean;
  /** true ⇒ nothing was sent (dry-run); only the payload was logged. */
  dryRun: boolean;
  materialsCost: number;
  contentHash: string | null;
}

export class MaterialsCostSyncService {
  private db = getDb();

  /** Push (or dry-run) the materials cost for one session. */
  async syncSession(sessionId: string, companyId = getSingletonCompanyId()): Promise<SyncResult> {
    const record = await this.db.query.sessionConsumption.findFirst({
      where: and(
        eq(sessionConsumption.companyId, companyId),
        eq(sessionConsumption.sessionId, sessionId),
      ),
    });
    if (!record) {
      return { found: false, idempotent: false, dryRun: true, materialsCost: 0, contentHash: null };
    }

    const materialsCost = Number(record.materialsCost);
    const payload = {
      source_system: SOURCE_SYSTEM,
      source_key: sessionId,
      siteId: record.siteId,
      sessionDate: record.sessionDate,
      materialsCost,
      version: record.version,
    };
    // Hash the *value*, not the metadata — an amended cost re-syncs, a re-run
    // of the same value is a no-op.
    const contentHash = createHash('sha256')
      .update(`${materialsCost}|${record.version}`)
      .digest('hex')
      .slice(0, 64);

    const existing = await this.db.query.bumblebeeSyncLog.findFirst({
      where: and(
        eq(bumblebeeSyncLog.sourceSystem, SOURCE_SYSTEM),
        eq(bumblebeeSyncLog.sourceKey, sessionId),
        eq(bumblebeeSyncLog.contentHash, contentHash),
      ),
    });
    if (existing && existing.status === 'SUCCESS') {
      return { found: true, idempotent: true, dryRun: existing.dryRun, materialsCost, contentHash };
    }

    const env = getEnv();
    const live = env.MATERIALS_COST_SYNC && !!env.BUMBLEBEE_API_BASE_URL;
    let status = 'SUCCESS';
    if (live) {
      try {
        await fetch(`${env.BUMBLEBEE_API_BASE_URL}/api/v1/consumption/materials-cost`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env.BUMBLEBEE_API_KEY ? { Authorization: `Bearer ${env.BUMBLEBEE_API_KEY}` } : {}),
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        status = 'FAILED';
        // Record the attempt; the daily retry / next amend re-tries.
        // eslint-disable-next-line no-console
        console.warn(`[materials-cost-sync] live post failed for ${sessionId}: ${(err as Error).message}`);
      }
    } else {
      // eslint-disable-next-line no-console
      console.info(`[materials-cost-sync] dry-run: would push £${materialsCost} for session ${sessionId}`);
    }

    await this.db
      .insert(bumblebeeSyncLog)
      .values({
        companyId,
        sourceSystem: SOURCE_SYSTEM,
        sourceKey: sessionId,
        contentHash,
        kind: 'materials_cost',
        status,
        dryRun: !live,
        amount: String(materialsCost),
        payload,
      })
      .onConflictDoNothing({
        target: [bumblebeeSyncLog.sourceSystem, bumblebeeSyncLog.sourceKey, bumblebeeSyncLog.contentHash],
      });

    return { found: true, idempotent: false, dryRun: !live, materialsCost, contentHash };
  }
}
