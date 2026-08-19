import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Package,
  Warehouse,
  Truck,
  Receipt,
  Settings,
  FolderTree,
  MapPin,
  PackageSearch,
  Banknote,
  Gauge,
  ShoppingBag,
  Square as SquareIcon,
  PackagePlus,
  ClipboardCheck,
  BookOpen,
  ChefHat,
  ClipboardList,
  BarChart3,
  FileText,
  AlertTriangle,
} from 'lucide-react';

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Big Bakes runs the stock half of this app only.
 *
 * The fork arrived with an e-commerce back office attached — Customers,
 * Orders, Invoices, Product groups (variant grouping), Gallery (image
 * captures, P23 groundwork that was never built) and Integrations. Those
 * routes still exist and still work; they are simply not in the nav, because
 * a menu of things nobody here will ever click is a menu people stop reading.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Products', to: '/products', icon: Package },
  // The list to work to zero before a venue test (Aug-2026, C-1/C-2/C-4).
  { label: 'Needs setup', to: '/products/needs-setup', icon: AlertTriangle },
  { label: 'Categories', to: '/categories', icon: FolderTree },
  { label: 'Sites', to: '/sites', icon: MapPin },
  { label: 'Stock by site', to: '/stock/by-site', icon: PackageSearch },
  { label: 'Reorder levels', to: '/stock/reorder', icon: Gauge },
  { label: 'Reorder suggestions', to: '/reorder', icon: ShoppingBag },
  { label: 'Goods in', to: '/pwa/goods-in', icon: PackagePlus },
  { label: 'Stock-take', to: '/pwa/stock-take', icon: ClipboardCheck },
  { label: 'End-of-session', to: '/pwa/consumption', icon: ChefHat },
  { label: 'Recipes', to: '/recipes', icon: BookOpen },
  { label: 'Consumption', to: '/consumption', icon: ClipboardList },
  { label: 'Reports', to: '/reports', icon: BarChart3 },
  { label: 'Square mapping', to: '/square', icon: SquareIcon },
  { label: 'Stock', to: '/stock', icon: Warehouse },
  { label: 'Suppliers', to: '/suppliers', icon: Truck },
  { label: 'Purchase Orders', to: '/purchase-orders', icon: Receipt },
  { label: 'Supplier Invoices', to: '/supplier-invoices', icon: FileText },
  { label: 'Xero accounts', to: '/xero-accounts', icon: Banknote },
  { label: 'Settings', to: '/settings', icon: Settings },
];

/** The other two Big Bakes apps. Pinned to the bottom because they're a way
 *  *out* of this app, not a page within it. */
const SISTER_APPS = [
  {
    label: 'BumbleBee',
    href: 'https://bumblebee.starship.thebigbakes.com',
    logo: '/logos/bumblebee.png',
  },
  {
    label: 'TheHippo',
    href: 'https://hippo.starship.thebigbakes.com',
    logo: '/logos/hippo.png',
  },
];

/**
 * Which nav entry is highlighted.
 *
 * Longest match wins. A plain `startsWith` lit up BOTH "Stock" and "Stock by
 * site" on /stock/by-site, because /stock is a prefix of it — two highlighted
 * rows and no way to tell where you actually are.
 */
export function activePath(pathname: string, items: NavItem[]): string | null {
  if (pathname === '/') return '/';
  return items
    .filter((i) => i.to !== '/' && (pathname === i.to || pathname.startsWith(`${i.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;
}

interface SidebarProps {
  /** When true, always show (used inside mobile Sheet). */
  alwaysShow?: boolean;
}

export function Sidebar({ alwaysShow = false }: SidebarProps = {}) {
  const { location } = useRouterState();
  const active = activePath(location.pathname, NAV_ITEMS);
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'flex w-60 shrink-0 flex-col bg-[var(--color-shell)] text-[var(--color-shell-foreground)]',
        alwaysShow ? 'block w-full border-r-0' : 'hidden md:flex',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-shell-border)] px-4">
        {/* 3:1 lockup — at h-8 that is ~96px, which leaves room for the app
            name in a 240px rail without either being cramped. */}
        <img src="/logos/big-bakes.png" alt="Big Bakes" className="h-8 w-auto" />
        <span className="text-sm font-semibold tracking-tight text-white">Big Bakes Stock</span>
      </div>

      {/* Only the list scrolls, so the sister-app buttons stay put. */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                // Salmon for the current page: the pin colour is the one thing
                // that reliably wins against a navy ground.
                active === item.to
                  ? 'bg-[var(--color-shell-active)] text-[var(--color-shell-active-foreground)] font-semibold'
                  : 'text-[var(--color-shell-muted)] hover:bg-[var(--color-shell-hover)] hover:text-white',
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-[var(--color-shell-border)] p-2">
        <p className="px-3 pb-1 text-xs font-medium text-[var(--color-shell-muted)]">
          Other apps
        </p>
        <div className="flex flex-col gap-2">
          {SISTER_APPS.map((app) => (
            <a
              key={app.href}
              href={app.href}
              target="_blank"
              rel="noopener noreferrer"
              // min-h-14 keeps these comfortably tappable on a shared iPad —
              // they're the one thing here people reach for with a full hand.
              className="flex min-h-14 items-center gap-3 rounded-md border border-[var(--color-shell-border)] px-3 py-2 text-sm font-medium text-[var(--color-shell-foreground)] transition-colors hover:bg-[var(--color-shell-hover)] hover:text-white"
            >
              <img src={app.logo} alt="" aria-hidden className="h-8 w-8 shrink-0 object-contain" />
              <span>{app.label}</span>
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
}
