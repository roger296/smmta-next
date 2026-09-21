import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PauseCircle, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { apiFetch } from '@/lib/api-client';
import type { Order } from '@/lib/api-types';

const MANUAL_HOLDER = 'manual';
const SHIPPED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED', 'CANCELLED'];

function useHoldMutation(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string | null) =>
      reason === null
        ? apiFetch(`/orders/${orderId}/hold`, { method: 'DELETE' })
        : apiFetch(`/orders/${orderId}/hold`, { method: 'PUT', body: { reason } }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      qc.invalidateQueries({ queryKey: ['orders', 'list'] });
    },
  });
}

/**
 * Why an order is on hold, and the button to hold or release it by hand.
 *
 * A held order is allocated stock as usual but gets no pick note or label and
 * cannot be shipped. Holds placed by an extension are listed here but released
 * from that extension's own panel, which knows what releasing them requires.
 */
export function OrderHoldPanel({ order }: { order: Order }) {
  const { toast } = useToast();
  const mutation = useHoldMutation(order.id);
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const holds = order.holds ?? [];
  const manual = holds.find((h) => h.holderKey === MANUAL_HOLDER);
  const closed = SHIPPED_STATUSES.includes(order.status);

  const run = async (value: string | null) => {
    try {
      await mutation.mutateAsync(value);
      setAsking(false);
      setReason('');
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not change the hold', description: err instanceof Error ? err.message : 'Unknown error' });
    }
  };

  if (holds.length === 0 && closed) return null;

  return (
    <div
      className={
        holds.length > 0
          ? 'space-y-2 border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-sm'
          : 'text-sm'
      }
      data-test="order-holds"
    >
      {holds.length > 0 && (
        <div>
          <p className="flex items-center gap-2 font-medium">
            <PauseCircle className="h-4 w-4" />
            On hold — no pick note or label, and it cannot be shipped
          </p>
          <ul className="list-disc pl-6">
            {holds.map((h) => (
              <li key={h.holderKey}>{h.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {manual ? (
        <Button size="sm" variant="outline" onClick={() => void run(null)} disabled={mutation.isPending} data-test="release-hold">
          <PlayCircle className="h-4 w-4" />
          Release my hold
        </Button>
      ) : asking ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(reason);
          }}
        >
          <Input
            autoFocus
            required
            maxLength={300}
            placeholder="Why is it on hold?"
            aria-label="Reason for the hold"
            className="max-w-md"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={mutation.isPending}>
            Put on hold
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        !closed && (
          <Button size="sm" variant="outline" onClick={() => setAsking(true)} data-test="hold-order">
            <PauseCircle className="h-4 w-4" />
            Put on hold
          </Button>
        )
      )}
    </div>
  );
}
