/**
 * Daily DNS check for the sending domain (spec § Deliverability): SPF must
 * include SendGrid, SendGrid's DKIM CNAMEs must exist, DMARC must be present.
 * Resolved over DNS-over-HTTPS, so it works from any container. The result is
 * stored as the `status_dns` row of `email_settings` and shown on the admin
 * Deliverability page.
 */
import { getDb } from '../../../config/database.js';
import { getEnv } from '../../../config/env.js';
import { emailSettings } from '../../../db/schema/index.js';

export interface DnsCheck {
  name: string;
  record: string;
  ok: boolean;
  found: string[];
  expect: string;
}

type Resolver = (name: string, type: 'TXT' | 'CNAME') => Promise<string[]>;

export const dohResolver: Resolver = async (name, type) => {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DNS ${res.status}`);
  const body = (await res.json()) as { Answer?: Array<{ data: string }> };
  return (body.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
};

export async function checkDns(resolve: Resolver = dohResolver, domain = getEnv().EMAIL_FROM_ADDRESS.split('@')[1] ?? ''): Promise<DnsCheck[]> {
  const checks: Array<Omit<DnsCheck, 'ok' | 'found'> & { type: 'TXT' | 'CNAME'; test: (v: string[]) => boolean }> = [
    { name: domain, record: 'SPF', type: 'TXT', expect: 'v=spf1 … include:sendgrid.net', test: (v) => v.some((t) => t.startsWith('v=spf1') && t.includes('include:sendgrid.net')) },
    { name: `s1._domainkey.${domain}`, record: 'DKIM s1', type: 'CNAME', expect: 'CNAME to *.sendgrid.net', test: (v) => v.some((t) => t.includes('sendgrid.net')) },
    { name: `s2._domainkey.${domain}`, record: 'DKIM s2', type: 'CNAME', expect: 'CNAME to *.sendgrid.net', test: (v) => v.some((t) => t.includes('sendgrid.net')) },
    { name: `_dmarc.${domain}`, record: 'DMARC', type: 'TXT', expect: 'v=DMARC1; p=…', test: (v) => v.some((t) => t.startsWith('v=DMARC1')) },
  ];
  const out: DnsCheck[] = [];
  for (const c of checks) {
    let found: string[] = [];
    try {
      found = await resolve(c.name, c.type);
      // _dmarc may be a CNAME to a hosted record: follow it once.
      if (c.record === 'DMARC' && !c.test(found)) {
        const cname = await resolve(c.name, 'CNAME');
        if (cname[0]) found = await resolve(cname[0].replace(/\.$/, ''), 'TXT');
      }
    } catch {
      found = [];
    }
    out.push({ name: c.name, record: c.record, expect: c.expect, found, ok: c.test(found) });
  }
  await getDb()
    .insert(emailSettings)
    .values({ key: 'status_dns', value: { checkedAt: new Date().toISOString(), checks: out }, updatedBy: 'system' })
    .onConflictDoUpdate({ target: emailSettings.key, set: { value: { checkedAt: new Date().toISOString(), checks: out }, updatedAt: new Date() } });
  return out;
}
