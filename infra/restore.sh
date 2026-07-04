#!/usr/bin/env bash
# Restore a pg_dump produced by infra/backup.sh (SPEC §6 — test before launch).
#
# Usage:  bash infra/restore.sh <dump-file> [target-database-url]
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file> [target-db-url]}"
TARGET="${2:-${DATABASE_URL:?set DATABASE_URL or pass a target}}"

[ -f "${DUMP}" ] || { echo "restore: no such file ${DUMP}" >&2; exit 1; }

echo "[restore] restoring ${DUMP} → ${TARGET}"
echo "[restore] WARNING: --clean drops and recreates objects in the target."
pg_restore --clean --if-exists --no-owner --dbname="${TARGET}" "${DUMP}"
echo "[restore] done — verify with: psql \"${TARGET}\" -c 'SELECT count(*) FROM domain_events;'"
