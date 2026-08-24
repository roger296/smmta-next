/**
 * Page-title helper.
 *
 * The root layout sets `title.template = '%s | Filament Store'`, which appends
 * the brand to every page title. Some catalogue rows already store a fully
 * formed SEO title that ends with the brand (the seeder writes
 * "<group> | Filament Store"), so passing those straight through produced
 * "… | Filament Store | Filament Store".
 *
 * `pageTitle` returns an `absolute` title when the supplied string already
 * carries the brand (bypassing the template), and a plain string otherwise so
 * the template still does its job.
 */
import type { Metadata } from 'next';

export const STORE_NAME = 'Filament Store';

export function pageTitle(seoTitle: string | null | undefined, fallback: string): Metadata['title'] {
  const chosen = (seoTitle ?? '').trim() || fallback;
  return chosen.toLowerCase().includes(STORE_NAME.toLowerCase())
    ? { absolute: chosen }
    : chosen;
}

/** Plain-string variant for Open Graph / Twitter, which have no template. */
export function socialTitle(seoTitle: string | null | undefined, fallback: string): string {
  const chosen = (seoTitle ?? '').trim() || fallback;
  return chosen.toLowerCase().includes(STORE_NAME.toLowerCase())
    ? chosen
    : `${chosen} | ${STORE_NAME}`;
}
