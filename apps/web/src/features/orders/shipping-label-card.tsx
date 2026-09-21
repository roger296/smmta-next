import * as React from 'react';
import { FilePlus, FileText, PenLine, RefreshCw, Truck, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import type { Order, ShippingLabel } from '@/lib/api-types';
import {
  openShippingLabel,
  useClearOwnLabel,
  useCreateShippingLabel,
  useSetOwnLabel,
  useShippingLabel,
} from './use-shipping-label';

const STATUS_COPY: Record<ShippingLabel['status'], string> = {
  PENDING: 'Label requested — waiting for Smooth Parcel.',
  CREATED: 'Label created and stored with this order.',
  FAILED: 'The last attempt to create a label failed.',
  DISABLED: 'Smooth Parcel isn’t connected yet, so no label was bought.',
};

const SHIPPED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'];

type OwnLabelOrder = Pick<Order, 'id' | 'status' | 'ownLabel' | 'courierName' | 'trackingNumber' | 'trackingLink'>;

/**
 * Shipping label for an order: its status, tracking number, the stored PDF,
 * and the buttons to get one.
 *
 * Paid storefront orders get a label automatically. When an attempt fails
 * after Smooth Parcel has created the shipment, "Try again" asks for that
 * shipment's label again, and "Create new shipment" is offered as the
 * deliberate alternative when that keeps failing.
 *
 * An order can instead go out with a label made outside this system: the
 * dispatcher types in the courier and tracking number, and no label is bought.
 */
export function ShippingLabelCard({ order }: { order: OwnLabelOrder }) {
  const orderId = order.id;
  const { toast } = useToast();
  const { data: label, isLoading } = useShippingLabel(orderId);
  const create = useCreateShippingLabel();
  const setOwn = useSetOwnLabel();
  const clearOwn = useClearOwnLabel();
  const [opening, setOpening] = React.useState(false);
  const [editingOwn, setEditingOwn] = React.useState(false);
  const [own, setOwnFields] = React.useState({ courierName: '', trackingNumber: '', trackingLink: '' });
  const hasFile = !!label?.hasLabelFile;
  const ownLabel = !!order.ownLabel;
  const isShipped = SHIPPED_STATUSES.includes(order.status);

  const onView = async () => {
    setOpening(true);
    try {
      await openShippingLabel(orderId);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not open label',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setOpening(false);
    }
  };

  const run = async (newShipment: boolean) => {
    try {
      const result = await create.mutateAsync({ orderId, newShipment });
      toast(
        result.status === 'CREATED'
          ? { title: 'Label created', description: result.trackingNumber ? `Tracking ${result.trackingNumber}` : undefined }
          : { variant: 'destructive', title: 'No label created', description: result.errorMessage ?? STATUS_COPY[result.status] },
      );
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Label failed',
        description: `${err instanceof Error ? err.message : 'Unknown error'}${
          label?.canCreateNewShipment || label?.providerOrderCode ? ' You can create a new shipment instead.' : ''
        }`,
      });
    }
  };

  const onCreate = () => {
    if (!window.confirm('Create a shipping label? This sends the order to Smooth Parcel.')) return;
    void run(false);
  };

  const onNewShipment = () => {
    const next = (label?.shipmentAttempt ?? 1) + 1;
    const old = label?.providerOrderCode ? ` The current shipment (${label.providerOrderCode}) stays in Smooth Parcel: delete it in the Smooth Parcel portal if it isn’t needed.` : '';
    if (
      !window.confirm(
        `Create a new shipment in Smooth Parcel for this order? It will be sent with the order number followed by -${next}.${old}`,
      )
    ) {
      return;
    }
    void run(true);
  };

  const onEditOwn = () => {
    setOwnFields({
      courierName: ownLabel ? (order.courierName ?? '') : '',
      trackingNumber: ownLabel ? (order.trackingNumber ?? '') : '',
      trackingLink: ownLabel ? (order.trackingLink ?? '') : '',
    });
    setEditingOwn(true);
  };

  const onSaveOwn = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setOwn.mutateAsync({ orderId, ...own });
      setEditingOwn(false);
      toast({ title: 'Your own label recorded', description: `${own.courierName.trim()} ${own.trackingNumber.trim()}` });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not record your label',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const onRemoveOwn = async () => {
    if (!window.confirm('Remove your own label from this order? Its courier and tracking number will be cleared.')) return;
    try {
      await clearOwn.mutateAsync(orderId);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not remove your label',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const failedWithShipment = !!label && label.status !== 'CREATED' && label.canCreateNewShipment;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-4 w-4" />
          Shipping label
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {editingOwn ? (
          <form className="space-y-2" onSubmit={onSaveOwn} data-test="own-label-form">
            <p className="text-[var(--color-muted-foreground)]">
              For a label you have made outside this system. The customer is sent this courier and tracking number.
            </p>
            <div className="space-y-1">
              <Label htmlFor="own-courier">Courier</Label>
              <Input
                id="own-courier"
                required
                maxLength={100}
                value={own.courierName}
                onChange={(e) => setOwnFields({ ...own, courierName: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="own-tracking">Tracking number</Label>
              <Input
                id="own-tracking"
                required
                maxLength={200}
                value={own.trackingNumber}
                onChange={(e) => setOwnFields({ ...own, trackingNumber: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="own-link">Tracking link (optional)</Label>
              <Input
                id="own-link"
                type="url"
                placeholder="https://"
                maxLength={500}
                value={own.trackingLink}
                onChange={(e) => setOwnFields({ ...own, trackingLink: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={setOwn.isPending}>
                {setOwn.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" type="button" variant="outline" onClick={() => setEditingOwn(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : ownLabel ? (
          <div className="space-y-1" data-test="own-label">
            <p>
              {isShipped
                ? 'Shipped with your own label.'
                : 'Going out with your own label. No label is bought for this order.'}
            </p>
            <p>
              Courier: <span className="font-medium">{order.courierName ?? '—'}</span>
            </p>
            <p>
              Tracking number: <span className="font-mono">{order.trackingNumber ?? '—'}</span>
            </p>
            {order.trackingLink && (
              <p>
                <a className="underline" href={order.trackingLink} target="_blank" rel="noreferrer">
                  Tracking link
                </a>
              </p>
            )}
          </div>
        ) : isLoading ? (
          <p className="text-[var(--color-muted-foreground)]">Loading…</p>
        ) : !label ? (
          <p className="text-[var(--color-muted-foreground)]">No label yet.</p>
        ) : (
          <div className="space-y-1" data-test="shipping-label-status" data-status={label.status}>
            <p>{STATUS_COPY[label.status]}</p>
            {label.courierName && (
              <p>
                Courier: <span className="font-medium">{label.courierName}</span>
                {label.shippingService && label.shippingService !== label.courierName ? ` (${label.shippingService})` : ''}
              </p>
            )}
            {label.trackingNumber && (
              <p>
                Tracking number: <span className="font-mono">{label.trackingNumber}</span>
              </p>
            )}
            {label.providerOrderCode && (
              <p className="text-[var(--color-muted-foreground)]">
                Smooth Parcel shipment: <span className="font-mono">{label.providerOrderCode}</span>
              </p>
            )}
            {(label.status === 'FAILED' || label.status === 'DISABLED') && label.errorMessage && (
              <p className="text-[var(--color-destructive)]">{label.errorMessage}</p>
            )}
            {failedWithShipment && (
              <p className="text-[var(--color-muted-foreground)]">
                Try again asks Smooth Parcel for this shipment’s label again. If that keeps failing, create a new
                shipment instead.
              </p>
            )}
            {label.previousShipmentCodes.length > 0 && (
              <p className="text-[var(--color-muted-foreground)]">
                Replaced shipments in Smooth Parcel: <span className="font-mono">{label.previousShipmentCodes.join(', ')}</span>
              </p>
            )}
          </div>
        )}
        {!editingOwn && ownLabel && !isShipped && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onEditOwn}>
              <PenLine className="h-4 w-4" />
              Change
            </Button>
            <Button size="sm" variant="outline" onClick={onRemoveOwn} disabled={clearOwn.isPending}>
              <X className="h-4 w-4" />
              Remove
            </Button>
          </div>
        )}
        {!editingOwn && !ownLabel && (
          <div className="flex flex-wrap gap-2">
            {hasFile ? (
              <Button size="sm" onClick={onView} disabled={opening}>
                <FileText className="h-4 w-4" />
                {opening ? 'Opening…' : 'View label'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={label ? () => void run(false) : onCreate} disabled={create.isPending || isLoading}>
                {label ? <RefreshCw className="h-4 w-4" /> : <Truck className="h-4 w-4" />}
                {create.isPending ? 'Working…' : label ? 'Try again' : 'Create label'}
              </Button>
            )}
            {failedWithShipment && (
              <Button size="sm" variant="outline" onClick={onNewShipment} disabled={create.isPending} data-test="new-shipment">
                <FilePlus className="h-4 w-4" />
                Create new shipment
              </Button>
            )}
            {!hasFile && !isShipped && (
              <Button size="sm" variant="outline" onClick={onEditOwn} data-test="use-own-label">
                <PenLine className="h-4 w-4" />
                Use my own label
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
