/**
 * The two public pages (unsubscribe and preferences): plain server-rendered
 * HTML with the store header. No scripts, no analytics, `noindex`, usable
 * without JavaScript and at phone width.
 */
import { MATERIALS } from '../lib/interests.js';
import { maskEmail } from '../lib/normalise.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STILL_RECEIVE =
  'You will still get the emails that go with anything you order — confirmations, dispatch and delivery updates, refunds — and any alerts you asked for, such as back-in-stock notices.';

export function layout(title: string, body: string, storeUrl: string): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · CleverDeals</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#ECECE8;color:#15161A;line-height:1.5}
  header{background:#15161A;color:#fff;padding:14px 16px}
  header a{color:#fff;text-decoration:none;font-weight:700;font-size:18px}
  main{max-width:560px;margin:0 auto;padding:24px 16px}
  .card{background:#F5F4F0;border:1px solid #C7CCD1;padding:20px}
  h1{font-size:22px;margin:0 0 12px}
  p{margin:0 0 12px}
  .muted{color:#6B6E76;font-size:14px}
  button{display:block;width:100%;padding:14px 16px;font-size:16px;font-weight:600;border:0;background:#3B5266;color:#fff;cursor:pointer}
  button:focus{outline:3px solid #B4C6D2}
  fieldset{border:1px solid #C7CCD1;margin:0 0 16px;padding:12px}
  legend{font-weight:600;padding:0 4px}
  label{display:flex;gap:10px;align-items:flex-start;padding:6px 0;font-size:16px}
  input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;flex:none}
  a{color:#3B5266}
  .ok{border-left:4px solid #3B5266;padding-left:12px}
</style>
</head>
<body>
<header><a href="${escapeHtml(storeUrl)}">CleverDeals</a></header>
<main><div class="card">${body}</div></main>
</body>
</html>`;
}

export function unsubscribeConfirmPage(opts: {
  email: string | null;
  status: 'all' | 'transactional_only' | 'never' | null;
  action: string;
  preferencesHref: string | null;
}): string {
  if (opts.status === 'never' || opts.status === 'transactional_only') {
    return `<h1>You are already unsubscribed</h1>
<p>${opts.email ? `<strong>${escapeHtml(maskEmail(opts.email))}</strong> does not get` : 'This address does not get'} our marketing emails.</p>
<p class="muted">${STILL_RECEIVE}</p>
${opts.preferencesHref && opts.status === 'transactional_only' ? `<p><a href="${escapeHtml(opts.preferencesHref)}">Email preferences</a></p>` : ''}`;
  }
  const who = opts.email ? `<strong>${escapeHtml(maskEmail(opts.email))}</strong>` : 'this address';
  return `<h1>Unsubscribe from marketing emails?</h1>
<p>Stop sending ${who} our newsletters, new-product alerts and offers.</p>
<p class="muted">${STILL_RECEIVE}</p>
<form method="post" action="${escapeHtml(opts.action)}">
<input type="hidden" name="confirm" value="1">
<button type="submit">Unsubscribe</button>
</form>
${opts.preferencesHref ? `<p class="muted" style="margin-top:16px">Or <a href="${escapeHtml(opts.preferencesHref)}">choose which emails you get</a>.</p>` : ''}`;
}

export function unsubscribedPage(preferencesHref: string | null): string {
  return `<h1 class="ok">You are unsubscribed</h1>
<p>We will not send you marketing emails any more.</p>
<p class="muted">${STILL_RECEIVE}</p>
${preferencesHref ? `<p><a href="${escapeHtml(preferencesHref)}">Changed your mind? Email preferences</a></p>` : ''}`;
}

export function invalidLinkPage(): string {
  return `<h1>This link has expired</h1>
<p>We could not find the email preferences this link was for. If you want to stop our marketing emails, use the unsubscribe link in the most recent one, or reply to it and we will sort it out.</p>`;
}

export interface PreferencesView {
  email: string;
  status: 'all' | 'transactional_only' | 'never';
  interests: string[];
  digestEnabled: boolean;
  newProductAlertsEnabled: boolean;
  action: string;
  saved?: boolean;
}

export function preferencesPage(v: PreferencesView): string {
  if (v.status === 'never') {
    return `<h1>Email preferences</h1>
<p><strong>${escapeHtml(maskEmail(v.email))}</strong> is set to receive no emails from us except those needed for an order you place.</p>
<p class="muted">To change that, reply to any email from us.</p>`;
  }
  const checked = (b: boolean) => (b ? ' checked' : '');
  const marketing = v.status === 'all';
  const materials = MATERIALS.map(
    (m) =>
      `<label><input type="checkbox" name="interest" value="${m.key}"${checked(v.interests.includes(m.key))}> ${escapeHtml(m.name)}</label>`,
  ).join('\n');
  return `<h1>Email preferences</h1>
<p>For <strong>${escapeHtml(maskEmail(v.email))}</strong>.</p>
${v.saved ? '<p class="ok">Saved.</p>' : ''}
<form method="post" action="${escapeHtml(v.action)}">
<fieldset>
<legend>Marketing emails</legend>
<label><input type="checkbox" name="marketing" value="1"${checked(marketing)}> Send me marketing emails</label>
<label><input type="checkbox" name="digest" value="1"${checked(v.digestEnabled)}> The weekly email, when there is something new for me</label>
<label><input type="checkbox" name="new_products" value="1"${checked(v.newProductAlertsEnabled)}> New-product alerts</label>
</fieldset>
<fieldset>
<legend>What I print with</legend>
${materials}
</fieldset>
<button type="submit">Save preferences</button>
</form>
<p class="muted" style="margin-top:16px">${STILL_RECEIVE} Unticking every box above unsubscribes you from all marketing.</p>`;
}
