/**
 * Deployment & UI-driven setup (P24, spec §A11). Asserts the fork installer +
 * systemd timers are shaped right, and the app boots dormant + read-only.
 *
 * Covers: the install plan deploys api + web + PWA + MCP and OMITS the
 * storefront; the four systemd timer/service units are valid; the app boots with
 * the dormant flags off and Xero in dry-run; a smoke test hits /health and the
 * /mcp discovery endpoint.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { closeDatabase } from './config/database.js';
import { getEnv } from './config/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const infra = (f: string) => path.resolve(here, '../../../infra', f);
const read = (f: string) => readFileSync(infra(f), 'utf8');

const TIMERS = ['smmta-reorder-sweep', 'smmta-consumption-sweep', 'smmta-square-poll', 'smmta-bumblebee-poll'];

describe('fork installer', () => {
  it('deploys api + web + PWA + MCP and omits the storefront', () => {
    const sh = read('install-autostock.sh');
    expect(sh).toMatch(/build -w @smmta\/api/);
    expect(sh).toMatch(/build -w @smmta\/web/);
    // The storefront is never built.
    expect(sh).not.toMatch(/npm run build -w @smmta\/store/);
    // Plan states it explicitly + keeps the storefront dormant.
    expect(sh).toMatch(/NOT deploying apps\/store/);
    expect(sh).toMatch(/XERO_DRY_RUN=true/);
    expect(sh).toMatch(/FEATURE_MARKETPLACE=false/);
    // All four timers are installed.
    for (const t of TIMERS) expect(sh).toContain(t);
  });
});

describe('systemd units', () => {
  it('the four timers + their oneshot services are valid', () => {
    for (const t of TIMERS) {
      const service = read(`systemd/${t}.service.template`);
      expect(existsSync(infra(`systemd/${t}.service.template`))).toBe(true);
      expect(service).toMatch(/\[Unit\]/);
      expect(service).toMatch(/\[Service\]/);
      expect(service).toMatch(/Type=oneshot/);
      expect(service).toMatch(/ExecStart=.*run-/);

      const timer = read(`systemd/${t}.timer.template`);
      expect(timer).toMatch(/\[Timer\]/);
      expect(timer).toMatch(/OnCalendar=/);
      expect(timer).toMatch(/\[Install\]/);
      expect(timer).toMatch(/WantedBy=timers\.target/);
    }
  });
});

describe('boot dormant + read-only', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDatabase();
  });

  it('the dormant flags are off and Xero is dry-run by default', () => {
    const env = getEnv();
    expect(env.XERO_DRY_RUN).toBe(true);
    expect(env.FEATURE_MARKETPLACE).toBe(false);
    expect(env.FEATURE_CONVERSATIONAL_SEARCH).toBe(false);
  });

  it('a smoke test hits /health and the MCP discovery endpoint', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const mcp = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json().resource).toMatch(/\/mcp$/);
  });
});
