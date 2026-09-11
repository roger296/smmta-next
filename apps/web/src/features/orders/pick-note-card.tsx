import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, FileText, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatDateTime } from '@/lib/format';
import type { PickNote } from '@/lib/api-types';
import { openPickNote, pickNoteKey, usePickNote, useRecreatePickNote } from './use-pick-note';

const STATUS_COPY: Record<PickNote['status'], string> = {
  PENDING: 'The pick note is being created.',
  CREATED: 'Pick note ready to print.',
  FAILED: 'The last attempt to create the pick note failed.',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The order's pick note: a list of what to pick, printed on a 4 x 4 inch label.
 * New orders get one automatically, and it is refreshed whenever the items
 * change; the button re-creates it on demand, for a lost print or a failure.
 */
export function PickNoteCard({ orderId }: { orderId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: note, isLoading } = usePickNote(orderId);
  const recreate = useRecreatePickNote();
  const [opening, setOpening] = React.useState(false);

  const onView = async () => {
    setOpening(true);
    try {
      await openPickNote(orderId);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not open the pick note',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setOpening(false);
      // Opening refreshes a stale note on the server, so reload its status.
      qc.invalidateQueries({ queryKey: pickNoteKey(orderId) });
    }
  };

  const onRecreate = async () => {
    try {
      const result = await recreate.mutateAsync(orderId);
      toast(
        result.status === 'CREATED'
          ? { title: 'Pick note created', description: `${plural(result.lineCount, 'line')}, ${plural(result.unitCount, 'unit')}` }
          : { variant: 'destructive', title: 'No pick note created', description: result.errorMessage ?? STATUS_COPY[result.status] },
      );
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Pick note failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const canView = !!note && (note.hasFile || note.isStale);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          Pick note
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <p className="text-[var(--color-muted-foreground)]">Loading…</p>
        ) : !note ? (
          <p className="text-[var(--color-muted-foreground)]">No pick note yet.</p>
        ) : (
          <div className="space-y-1" data-test="pick-note-status" data-status={note.status}>
            <p>{STATUS_COPY[note.status]}</p>
            {note.status === 'CREATED' && (
              <p className="text-[var(--color-muted-foreground)]">
                {plural(note.lineCount, 'line')}, {plural(note.unitCount, 'unit')}
                {note.generatedAt ? ` · made ${formatDateTime(note.generatedAt)}` : ''}
              </p>
            )}
            {note.isStale && (
              <p>The order has changed since this was made. It will be updated when you open it.</p>
            )}
            {note.status === 'FAILED' && note.errorMessage && (
              <p className="text-[var(--color-destructive)]">{note.errorMessage}</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {canView && (
            <Button size="sm" onClick={onView} disabled={opening}>
              <FileText className="h-4 w-4" />
              {opening ? 'Opening…' : 'View pick note'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRecreate} disabled={recreate.isPending || isLoading}>
            <RefreshCw className="h-4 w-4" />
            {recreate.isPending ? 'Creating…' : note ? 'Re-create' : 'Create pick note'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
