import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  ShoppingCart,
  FileText,
  Package,
  Warehouse,
  Truck,
  Receipt,
  Settings,
  Layers,
  Boxes,
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
} from 'lucide-react';

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Customers', to: '/customers', icon: Users },
  { label: 'Orders', to: '/orders', icon: ShoppingCart },
  { label: 'Invoices', to: '/invoices', icon: FileText },
  { label: 'Products', to: '/products', icon: Package },
  { label: 'Product groups', to: '/product-groups', icon: Boxes },
  { label: 'Categories', to: '/categories', icon: FolderTree },
  { label: 'Sites', to: '/sites', icon: MapPin },
  { label: 'Stock by site', to: '/stock/by-site', icon: PackageSearch },
  { label: 'Reorder levels', to: '/stock/reorder', icon: Gauge },
  { label: 'Reorder suggestions', to: '/reorder', icon: ShoppingBag },
  { label: 'Goods in', to: '/pwa/goods-in', icon: PackagePlus },
  { label: 'Stock-take', to: '/pwa/stock-take', icon: ClipboardCheck },
  { label: 'Recipes', to: '/recipes', icon: BookOpen },
  { label: 'Square mapping', to: '/square', icon: SquareIcon },
  { label: 'Stock', to: '/stock', icon: Warehouse },
  { label: 'Suppliers', to: '/suppliers', icon: Truck },
  { label: 'Purchase Orders', to: '/purchase-orders', icon: Receipt },
  { label: 'Supplier Invoices', to: '/supplier-invoices', icon: FileText },
  { label: 'Integrations', to: '/integrations', icon: Layers },
  { label: 'Xero accounts', to: '/xero-accounts', icon: Banknote },
  { label: 'Settings', to: '/settings', icon: Settings },
];

interface SidebarProps {
  /** When true, always show (used inside mobile Sheet). */
  alwaysShow?: boolean;
}

export function Sidebar({ alwaysShow = false }: SidebarProps = {}) {
  const { location } = useRouterState();
  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        'w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)]',
        alwaysShow ? 'block w-full border-r-0' : 'hidden md:block',
      )}
    >
      <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
        <span className="text-base font-semibold">Auto-Stock</span>
      </div>
      <nav className="flex flex-col gap-1 p-2">
        {NAV_ITEMS.map((item) => {
          const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)] font-medium'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
