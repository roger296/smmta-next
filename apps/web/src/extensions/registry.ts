/**
 * Admin-app extensions: screens a business adds to its own copy of this repo
 * without editing the core. The partner of apps/api/src/extensions.
 *
 * Every folder here with an index.ts or index.tsx is picked up at build time.
 * The folder is empty upstream. An extension default-exports a WebExtension:
 *
 *   - pages        its own screens, shown at /x/<key>/<page>
 *   - navItems     links to those screens in the sidebar
 *   - orderPanels  components shown at the top of every order page, given the
 *                  order; render nothing for an order that is none of your
 *                  business
 *
 * New files only: if the core needs a new slot, add it upstream, for everyone.
 */
import type * as React from 'react';
import type { Order } from '@/lib/api-types';

export interface WebExtensionNavItem {
  label: string;
  /** A key of `pages`. */
  page: string;
  icon?: React.ComponentType<{ className?: string }>;
}

export interface WebExtension {
  /** Matches the API extension's key: lower-case letters, digits, underscores. */
  key: string;
  pages?: Record<string, React.ComponentType>;
  navItems?: WebExtensionNavItem[];
  orderPanels?: Array<React.ComponentType<{ order: Order }>>;
}

const modules = import.meta.glob<{ default?: WebExtension }>('./*/index.{ts,tsx}', { eager: true });

const extensions: WebExtension[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path]?.default)
  .filter((ext): ext is WebExtension => !!ext && typeof ext.key === 'string');

export function webExtensions(): WebExtension[] {
  return extensions;
}

export function extensionPage(key: string, page: string): React.ComponentType | null {
  return extensions.find((e) => e.key === key)?.pages?.[page] ?? null;
}

export function extensionPath(key: string, page: string): string {
  return `/x/${key}/${page}`;
}
