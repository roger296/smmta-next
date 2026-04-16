import { format, parseISO } from 'date-fns';

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
};

export function formatMoney(
  value: number | string | null | undefined,
  currency = 'GBP',
): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(num)) return '—';
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const formatted = num.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  try {
    const date = typeof iso === 'string' ? parseISO(iso) : iso;
    return format(date, 'd MMM yyyy');
  } catch {
    return '—';
  }
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  try {
    const date = typeof iso === 'string' ? parseISO(iso) : iso;
    return format(date, 'd MMM yyyy HH:mm');
  } catch {
    return '—';
  }
}

export function formatPercent(
  value: number | string | null | undefined,
  decimals = 1,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(num)) return '—';
  return `${num.toFixed(decimals)}%`;
}
