import * as React from 'react';
import { FilePlus, FileText, RefreshCw, Truck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import type { ShippingLabel } from '@/lib/api-types';
import { openShippingLabel, useCreateShippingLabel, useShippingLabel } from './use-shipping-label';

const STATUS_COPY: Record<ShippingLabel['status'], string> = {
  PENDING: 'Label requested — waiting for Smooth Parcel.',
  CREATED: 'Label created and stored with this order.',
  FAILED: 'The last attempt to create a label failed.',
  DISABLED: 'Smooth Parcel isn’t connected yet, so no label was bought.',
};

/**
 * Shipping label for an order: its status, tracking number, the stored PDF,
 * and the buttons to get one.
 *
 * Paid storefront orders get a label automatically. When an attempt fails
 * after Smooth Parcel has created the shipment, "Try again" asks for that
 * shipment's label again, and "Create new shipment" is offered as the
 * deliberate alternative when that keeps failing.
 */
export function ShippingLabelCard({ orderId }: { orderId: string }) {
  const { toast } = useToast();
  const { data: label, isLoading } = useShippingLabel(orderId);
  const create = useCreateShippingLabel();
  const [opening, setOpening] = React.useState(false);
  const hasFile = !!label?.hasLabelFile;

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
        {isLoading ? (
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
        </div>
      </CardContent>
    </Card>
  );
}
