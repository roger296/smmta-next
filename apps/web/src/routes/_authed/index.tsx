import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  useDashboardOverview,
  type DashboardOverview,
  type DashboardSite,
} from '@/features/dashboard/use-dashboard';
import { formatMoney } from '@/lib/format';
import { ClipboardCheck, ShoppingBasket, Warehouse } from 'lucide-react';

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
});

/** Shown in place of a tile's table when that tile can't answer yet. Kept
 *  deliberately plain and instructive — during setup these ARE the dashboard's
 *  most useful content, because they say what still needs configuring. */
function NotReady({ children }: { children: React.ReactNode }) {
  return (
    <p className="p-6 text-sm text-[var(--color-muted-foreground)]">{children}</p>
  );
}

function Tile({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 pb-3">
        <Icon className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {subtitle && (
            <p className="text-xs text-[var(--color-muted-foreground)]">{subtitle}</p>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={`px-4 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}>{children}</th>
);
const Td = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <td className={`px-4 py-2 ${right ? 'text-right' : ''}`}>{children}</td>
);

function siteName(sites: DashboardSite[], id: string): string {
  return sites.find((s) => s.id === id)?.name ?? 'Unknown site';
}

function SessionsTile({ data }: { data: DashboardOverview }) {
  const { sessions, sites, date } = data;
  return (
    <Tile
      icon={ClipboardCheck}
      title="Consumption statements"
      subtitle={`Bake sessions on ${date}`}
    >
      {!sessions.available ? (
        <NotReady>{sessions.reason}</NotReady>
      ) : sessions.rows.every((r) => r.sessions === 0) ? (
        <NotReady>No bake sessions recorded for {date}.</NotReady>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
            <tr>
              <Th>Site</Th>
              <Th right>Sessions</Th>
              <Th right>Filed</Th>
              <Th right>Outstanding</Th>
            </tr>
          </thead>
          <tbody>
            {sessions.rows.map((r) => (
              <tr key={r.siteId} className="border-b border-[var(--color-border)] last:border-b-0">
                <Td>{siteName(sites, r.siteId)}</Td>
                <Td right>{r.sessions}</Td>
                <Td right>{r.filed}</Td>
                <Td right>
                  {r.missing === 0 ? (
                    <Badge variant="secondary">All in</Badge>
                  ) : (
                    <Badge variant="destructive">{r.missing} missing</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* A site BumbleBee couldn't answer for is simply absent from the table
          above, so say which and why rather than letting it read as "no bakes". */}
      {sessions.available && sessions.reason && (
        <p className="border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-destructive)]">
          {sessions.reason}
        </p>
      )}
    </Tile>
  );
}

function StockTile({ data }: { data: DashboardOverview }) {
  const { stock, sites } = data;
  return (
    <Tile icon={Warehouse} title="Stock held" subtitle="Value on hand by site">
      {stock.rows.length === 0 ? (
        <NotReady>{stock.reason ?? 'No stock recorded.'}</NotReady>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
            <tr>
              <Th>Site</Th>
              <Th right>Lines</Th>
              <Th right>Value</Th>
            </tr>
          </thead>
          <tbody>
            {stock.rows.map((r) => (
              <tr key={r.siteId} className="border-b border-[var(--color-border)] last:border-b-0">
                <Td>{siteName(sites, r.siteId)}</Td>
                <Td right>{r.linesTracked}</Td>
                <Td right>{formatMoney(r.value, r.currencyCode)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Tile>
  );
}

function ReorderTile({ data }: { data: DashboardOverview }) {
  const { reorder, sites } = data;
  const nothingFlagged = reorder.rows.every(
    (r) => r.belowReorderPoint === 0 && r.openProposals === 0,
  );
  return (
    <Tile icon={ShoppingBasket} title="Needs ordering" subtitle="Items at or below their reorder point">
      {nothingFlagged ? (
        <NotReady>
          {reorder.reason ?? 'Nothing below its reorder point — all sites are stocked.'}
        </NotReady>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
            <tr>
              <Th>Site</Th>
              <Th right>Below point</Th>
              <Th right>Proposed orders</Th>
              <Th>Examples</Th>
            </tr>
          </thead>
          <tbody>
            {reorder.rows.map((r) => (
              <tr key={r.siteId} className="border-b border-[var(--color-border)] last:border-b-0">
                <Td>{siteName(sites, r.siteId)}</Td>
                <Td right>
                  {r.belowReorderPoint > 0 ? (
                    <Badge variant="destructive">{r.belowReorderPoint}</Badge>
                  ) : (
                    0
                  )}
                </Td>
                <Td right>{r.openProposals}</Td>
                <Td>
                  <span className="text-[var(--color-muted-foreground)]">
                    {r.topItems.map((i) => i.name).join(', ') || '—'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Tile>
  );
}

function DashboardPage() {
  const { data, isLoading, isError, error } = useDashboardOverview();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
    );
  }

  // Only reached if the single overview call itself fails — individual tiles
  // report their own problems inline rather than blanking the page.
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Could not load the dashboard.
            {error instanceof Error ? ` ${error.message}` : ''}
          </p>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            The rest of the app is unaffected — try{' '}
            <Link to="/stock/by-site" className="text-[var(--color-primary)] hover:underline">
              Stock by site
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          What needs attention across all {data.sites.length} sites.
        </p>
      </div>
      <SessionsTile data={data} />
      <div className="grid gap-6 lg:grid-cols-2">
        <StockTile data={data} />
        <ReorderTile data={data} />
      </div>
    </div>
  );
}
