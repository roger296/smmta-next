import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWarehouses } from '../reference/use-reference';

interface AllocateStockDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultWarehouseId?: string;
  onConfirm: (warehouseId: string) => Promise<void>;
}

export function AllocateStockDialog({
  open,
  onOpenChange,
  defaultWarehouseId,
  onConfirm,
}: AllocateStockDialogProps) {
  const { data: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = React.useState(defaultWarehouseId ?? '');
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) setWarehouseId(defaultWarehouseId ?? '');
  }, [open, defaultWarehouseId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allocate stock</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="alloc-warehouse">Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger id="alloc-warehouse">
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={!warehouseId || pending}
            onClick={async () => {
              setPending(true);
              try {
                await onConfirm(warehouseId);
                onOpenChange(false);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Allocating…' : 'Allocate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CreateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (input: { dateOfInvoice: string; dueDateOfInvoice?: string }) => Promise<void>;
}

export function CreateInvoiceDialog({ open, onOpenChange, onConfirm }: CreateInvoiceDialogProps) {
  const [dateOfInvoice, setDateOfInvoice] = React.useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [dueDate, setDueDate] = React.useState('');
  const [pending, setPending] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create invoice from order</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="inv-date">Invoice date</Label>
            <Input
              id="inv-date"
              type="date"
              value={dateOfInvoice}
              onChange={(e) => setDateOfInvoice(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inv-due">Due date</Label>
            <Input
              id="inv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await onConfirm({
                  dateOfInvoice,
                  dueDateOfInvoice: dueDate || undefined,
                });
                onOpenChange(false);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Creating…' : 'Create invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
