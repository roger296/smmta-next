import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  WEEKDAYS,
  type SiteAccountInput,
  type SiteAccountView,
  useSaveSiteAccount,
  useSiteAccounts,
} from './use-site-accounts';
import { describeCutoff, describeDeliveries, describeNextDelivery, pounds } from './describe';

/**
 * "Venues & delivery" — this supplier's account at each venue: the account
 * number, the delivery round or lead time, the cut-off, the minimum order and
 * the delivery charge. What the ordering screen will use to say when an order
 * placed now ARRIVES (docs/plans/SUPPLIER_ORDERING_PLAN.md §3.2).
 */
export function SiteAccountsTab({ supplierId }: { supplierId: string }) {
  const { data, isLoading, isError, error } = useSiteAccounts(supplierId);
  const [editing, setEditing] = React.useState<SiteAccountView | null>(null);

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Could not load venues: {error instanceof Error ? error.message : 'unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Venues &amp; delivery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          This supplier&rsquo;s account at each venue. Give either the <strong>days they deliver</strong>{' '}
          with an order cut-off, or a <strong>lead time</strong> in working days if they have no fixed
          round. Times are the venue&rsquo;s local time. Ordering uses this to work out when an order
          placed now would arrive.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Venue</th>
                <th className="px-3 py-2 text-left font-medium">Account no.</th>
                <th className="px-3 py-2 text-left font-medium">Delivers</th>
                <th className="px-3 py-2 text-left font-medium">Order cut-off</th>
                <th className="px-3 py-2 text-right font-medium">Min order</th>
                <th className="px-3 py-2 text-right font-medium">Delivery</th>
                <th className="px-3 py-2 text-left font-medium">If ordered now</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr
                  key={v.site.id}
                  data-testid={`site-account-${v.site.id}`}
                  className="border-b border-[var(--color-border)] last:border-b-0"
                >
                  <td className="px-3 py-2 font-medium">{v.site.name}</td>
                  <td className="px-3 py-2">{v.account?.accountNumber ?? '—'}</td>
                  <td className="px-3 py-2">{v.account ? describeDeliveries(v.account) : '—'}</td>
                  <td className="px-3 py-2">{v.account ? describeCutoff(v.account) : '—'}</td>
                  <td className="px-3 py-2 text-right">{pounds(v.account?.minOrderValue ?? null)}</td>
                  <td className="px-3 py-2 text-right">
                    {pounds(v.account?.deliveryCharge ?? null)}
                    {v.account?.freeDeliveryOver != null && (
                      <span className="block text-xs text-[var(--color-muted-foreground)]">
                        free over {pounds(v.account.freeDeliveryOver)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{describeNextDelivery(v)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(v)}>
                      {v.account ? 'Edit' : 'Add'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
      {editing && (
        <EditSiteAccountDialog supplierId={supplierId} view={editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

interface FormState {
  accountNumber: string;
  ediLocationId: string;
  deliveryDays: string[];
  cutoffTime: string;
  cutoffDaysBefore: string;
  leadDays: string;
  minOrderValue: string;
  deliveryCharge: string;
  freeDeliveryOver: string;
  orderEmail: string;
  portalUrl: string;
  notes: string;
  isActive: boolean;
}

function toForm(v: SiteAccountView): FormState {
  const a = v.account;
  return {
    accountNumber: a?.accountNumber ?? '',
    ediLocationId: a?.ediLocationId ?? '',
    deliveryDays: a?.deliveryDays ?? [],
    cutoffTime: a?.cutoffTime?.slice(0, 5) ?? '',
    cutoffDaysBefore: String(a?.cutoffDaysBefore ?? 1),
    leadDays: a?.leadDays != null ? String(a.leadDays) : '',
    minOrderValue: a?.minOrderValue ?? '',
    deliveryCharge: a?.deliveryCharge ?? '',
    freeDeliveryOver: a?.freeDeliveryOver ?? '',
    orderEmail: a?.orderEmail ?? '',
    portalUrl: a?.portalUrl ?? '',
    notes: a?.notes ?? '',
    isActive: a?.isActive ?? true,
  };
}

/** Blank is "not known" (null), never 0 — a £0.00 minimum is a real answer. */
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function toInput(f: FormState): SiteAccountInput {
  return {
    accountNumber: f.accountNumber.trim() || null,
    ediLocationId: f.ediLocationId.trim() || null,
    deliveryDays: f.deliveryDays,
    cutoffTime: f.cutoffTime.trim() || null,
    cutoffDaysBefore: Number(f.cutoffDaysBefore) || 0,
    leadDays: numOrNull(f.leadDays),
    minOrderValue: numOrNull(f.minOrderValue),
    deliveryCharge: numOrNull(f.deliveryCharge),
    freeDeliveryOver: numOrNull(f.freeDeliveryOver),
    orderEmail: f.orderEmail.trim() || null,
    portalUrl: f.portalUrl.trim() || null,
    notes: f.notes.trim() || null,
    isActive: f.isActive,
  };
}

function EditSiteAccountDialog({
  supplierId,
  view,
  onClose,
}: {
  supplierId: string;
  view: SiteAccountView;
  onClose: () => void;
}) {
  const [form, setForm] = React.useState<FormState>(() => toForm(view));
  const save = useSaveSiteAccount(supplierId);
  const { toast } = useToast();
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const toggleDay = (d: string) =>
    set({ deliveryDays: form.deliveryDays.includes(d) ? form.deliveryDays.filter((x) => x !== d) : [...form.deliveryDays, d] });
  const hasRound = form.deliveryDays.length > 0;

  const onSave = async () => {
    try {
      await save.mutateAsync({ siteId: view.site.id, input: toInput(form) });
      toast({ title: `${view.site.name} saved` });
      onClose();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };

  const field = (id: keyof FormState, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`sa-${id}`}>{label}</Label>
      <Input
        id={`sa-${id}`}
        value={form[id] as string}
        onChange={(e) => set({ [id]: e.target.value } as Partial<FormState>)}
        {...props}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{view.site.name}</DialogTitle>
          <DialogDescription>Times are {view.site.name}&rsquo;s local time ({view.site.timezone}).</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {field('accountNumber', 'Account number')}
          {field('ediLocationId', 'Electronic location ID (e.g. Booker)')}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Delivery days</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => (
              <label key={d} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={form.deliveryDays.includes(d)} onChange={() => toggleDay(d)} />
                {d.charAt(0) + d.slice(1).toLowerCase()}
              </label>
            ))}
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Leave all unticked if they have no fixed round, and give a lead time instead.
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          {field('cutoffTime', 'Order cut-off', { type: 'time' })}
          {hasRound
            ? field('cutoffDaysBefore', 'Days before delivery', { type: 'number', min: 0, max: 14 })
            : field('leadDays', 'Lead time (working days)', { type: 'number', min: 0, max: 60 })}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {field('minOrderValue', 'Minimum order (£)', { inputMode: 'decimal' })}
          {field('deliveryCharge', 'Delivery charge (£)', { inputMode: 'decimal' })}
          {field('freeDeliveryOver', 'Free delivery over (£)', { inputMode: 'decimal' })}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {field('orderEmail', 'Order email for this venue', { type: 'email' })}
          {field('portalUrl', 'Ordering website', { type: 'url' })}
        </div>

        <div className="space-y-1">
          <Label htmlFor="sa-notes">Notes</Label>
          <Textarea id="sa-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          We order from this supplier for this venue
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
