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
  { label: 'Stock', to: '/stock', icon: Warehouse },
  { label: 'Suppliers', to: '/suppliers', icon: Truck },
  { label: 'Purchase Orders', to: '/purchase-orders', icon: Receipt },
  { label: 'Supplier Invoices', to: '/supplier-invoices', icon: FileText },
  { label: 'Integrations', to: '/integrations', icon: Layers },
  { label: 'Settings', to: '/settings', icon: Settings },
];

export function Sidebar() {
  const { location } = useRouterState();
  return (
    <aside
      aria-label="Main navigation"
      className="hidden w-60 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] md:block"
    >
      <div className="flex h-14 items-center border-b border-[var(--color-border)] px-4">
        <span className="text-base font-semibold">SMMTA-Next</span>
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
