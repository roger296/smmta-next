import * as React from 'react';
import { FileText, Truck } from 'lucide-react';
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
 * and a button to create one. Paid storefront orders get a label automatically;
 * this button covers admin-created orders and retries.
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

  const onCreate = async () => {
    // A label costs money, so the operator confirms before one is bought.
    if (!window.confirm('Create a shipping label? This buys a label from Smooth Parcel and charges your Smooth Parcel balance.')) {
      return;
    }
    try {
      const result = await create.mutateAsync(orderId);
      toast(
        result.status === 'CREATED'
          ? { title: 'Label created', description: result.trackingNumber ? `Tracking ${result.trackingNumber}` : undefined }
          : { variant: 'destructive', title: 'No label created', description: result.errorMessage ?? STATUS_COPY[result.status] },
      );
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Label failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

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
            {label.trackingNumber && (
              <p>
                Tracking number: <span className="font-mono">{label.trackingNumber}</span>
              </p>
            )}
            {(label.status === 'FAILED' || label.status === 'DISABLED') && label.errorMessage && (
              <p className="text-[var(--color-destructive)]">{label.errorMessage}</p>
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
            <Button size="sm" variant="outline" onClick={onCreate} disabled={create.isPending || isLoading}>
              <Truck className="h-4 w-4" />
              {create.isPending ? 'Creating…' : label ? 'Try again' : 'Create label'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
