#!/usr/bin/env bash
# Nightly backup (SPEC §6). Because pg-boss + the event log live in Postgres, a
# single pg_dump captures orders, stock, AND pending jobs — whole-system state.
# Pushes off-box via rclone (target from BACKUP_RCLONE_REMOTE). Test a restore
# before launch (see RESTORE.md).
#
# Usage:  bash infra/backup.sh          # dump + push
#         DRY_RUN=1 bash infra/backup.sh # print what it would do, no side effects
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-/home/smmta/backups}"
OUT_FILE="${OUT_DIR}/smmta_next_${STAMP}.dump"
REMOTE="${BACKUP_RCLONE_REMOTE:-}"

echo "[backup] target file: ${OUT_FILE}"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "[backup] DRY_RUN — would pg_dump ${DATABASE_URL} → ${OUT_FILE}"
  [ -n "${REMOTE}" ] && echo "[backup] DRY_RUN — would rclone copy ${OUT_FILE} ${REMOTE}"
  exit 0
fi

mkdir -p "${OUT_DIR}"
# Custom format (-Fc) → parallel/selective restore with pg_restore.
pg_dump -Fc --no-owner --dbname="${DATABASE_URL}" --file="${OUT_FILE}"
echo "[backup] wrote $(du -h "${OUT_FILE}" | cut -f1)"

if [ -n "${REMOTE}" ]; then
  rclone copy "${OUT_FILE}" "${REMOTE}" && echo "[backup] pushed to ${REMOTE}"
else
  echo "[backup] BACKUP_RCLONE_REMOTE unset — kept local only (set it for off-box safety)"
fi

# Retain 14 local dumps.
ls -1t "${OUT_DIR}"/smmta_next_*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "[backup] done"
