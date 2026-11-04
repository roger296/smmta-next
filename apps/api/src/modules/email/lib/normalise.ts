/**
 * Email normalisation (spec § CSV import): trim, lower-case, strip
 * surrounding angle brackets and `mailto:`. No Gmail dot-folding — the
 * address is treated as given.
 */
export function normaliseEmail(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (s.toLowerCase().startsWith('mailto:')) s = s.slice('mailto:'.length).trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s.toLowerCase();
}

// Deliberately plain: one @, something either side, a dot in the domain, no
// spaces. Deliverability is Bouncer's job; this only catches garbage.
const SHAPE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 320 && SHAPE.test(email);
}

/** Shows enough of an address to recognise it and no more: `ro***@example.com`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
