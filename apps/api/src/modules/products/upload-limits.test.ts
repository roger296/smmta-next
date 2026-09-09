/**
 * The proxy must allow at least what the API accepts.
 *
 * Image uploads reach the API through the admin SPA's nginx proxy. nginx
 * defaults client_max_body_size to 1m, so every photograph over that was
 * rejected by the proxy with its own HTML 413 — before the request reached the
 * API, which accepts 8MB and advertises that in the UI. Small test images
 * worked, real phone photographs did not, and nothing in the application logs
 * showed a thing.
 *
 * This guards the invariant rather than the specific number: whatever the API's
 * cap becomes, the proxy in front of it has to be at least as generous, or the
 * API's limit is not the one in force.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from './image-upload.routes.js';

// Resolved from this file, not process.cwd(): vitest is invoked with --root
// from the repo root in some CI steps and from a workspace directory in
// others, so cwd is not a stable base for reading a repo file.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const NGINX_CONF = join(REPO_ROOT, 'docker', 'web-nginx.conf');

function parseSize(value: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(value.trim());
  if (!m) throw new Error(`Unparseable nginx size: ${value}`);
  const n = Number(m[1]);
  const unit = (m[2] || '').toLowerCase();
  return unit === 'g' ? n * 1024 ** 3 : unit === 'm' ? n * 1024 ** 2 : unit === 'k' ? n * 1024 : n;
}

describe('admin proxy upload limit', () => {
  const conf = readFileSync(NGINX_CONF, 'utf8');

  it('sets client_max_body_size explicitly', () => {
    // Absent means nginx's 1m default applies, which is the bug this prevents.
    expect(conf).toMatch(/client_max_body_size\s+\d+[kmg]?;/i);
  });

  it('allows at least as much as the API accepts', () => {
    const m = /client_max_body_size\s+(\d+[kmg]?)\s*;/i.exec(conf);
    const limit = parseSize(m![1]!);
    expect(limit).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('leaves headroom for multipart framing above the API cap', () => {
    // A file exactly at the cap arrives slightly larger once the multipart
    // boundary and headers are counted, so an exactly-equal proxy limit would
    // still reject it.
    const m = /client_max_body_size\s+(\d+[kmg]?)\s*;/i.exec(conf);
    expect(parseSize(m![1]!)).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });
});
