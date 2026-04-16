import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/forms/form-field';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  useCreateWarehouse,
  useUpdateWarehouse,
  type CreateWarehouseInput,
} from './use-reference';
import { useToast } from '@/hooks/use-toast';
import type { Warehouse } from '@/lib/api-types';

const schema = z.object({
  name: z.string().min(1, 'Name required').max(200),
  addressLine1: z.string().optional().or(z.literal('')),
  addressLine2: z.string().optional().or(z.literal('')),
  city: z.string().optional().or(z.literal('')),
  region: z.string().optional().or(z.literal('')),
  postCode: z.string().optional().or(z.literal('')),
  country: z.string().optional().or(z.literal('')),
  isDefault: z.boolean().default(false),
});
type FormValues = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  warehouse?: Warehouse | null;
}

export function WarehouseDialog({ open, onOpenChange, warehouse }: Props) {
  const { toast } = useToast();
  const createMutation = useCreateWarehouse();
  const updateMutation = useUpdateWarehouse();
  const isEdit = !!warehouse;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', isDefault: false },
  });

  React.useEffect(() => {
    if (open) {
      reset({
        name: warehouse?.name ?? '',
        addressLine1: warehouse?.addressLine1 ?? '',
        addressLine2: warehouse?.addressLine2 ?? '',
        city: warehouse?.city ?? '',
        region: warehouse?.region ?? '',
        postCode: warehouse?.postCode ?? '',
        country: warehouse?.country ?? '',
        isDefault: warehouse?.isDefault ?? false,
      });
    }
  }, [open, warehouse, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit warehouse' : 'New warehouse'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update warehouse details.' : 'Add a warehouse location.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(async (v) => {
            const cleaned: CreateWarehouseInput = {
              name: v.name,
              addressLine1: v.addressLine1 || undefined,
              addressLine2: v.addressLine2 || undefined,
              city: v.city || undefined,
              region: v.region || undefined,
              postCode: v.postCode || undefined,
              country: v.country || undefined,
              isDefault: v.isDefault,
            };
            try {
              if (isEdit && warehouse) {
                await updateMutation.mutateAsync({ id: warehouse.id, input: cleaned });
                toast({ title: 'Warehouse updated' });
              } else {
                await createMutation.mutateAsync(cleaned);
                toast({ title: 'Warehouse created' });
              }
              onOpenChange(false);
            } catch (err) {
              toast({
                variant: 'destructive',
                title: 'Failed',
                description: err instanceof Error ? err.message : 'Unknown',
              });
            }
          })}
          className="space-y-3"
        >
          <Field id="wh-name" label="Name" required error={errors.name?.message}>
            <Input {...register('name')} />
          </Field>
          <Field id="wh-addressLine1" label="Address line 1">
            <Input {...register('addressLine1')} />
          </Field>
          <Field id="wh-addressLine2" label="Address line 2">
            <Input {...register('addressLine2')} />
          </Field>
          <div className="grid gap-3 md:grid-cols-3">
            <Field id="wh-city" label="City">
              <Input {...register('city')} />
            </Field>
            <Field id="wh-postCode" label="Postcode">
              <Input {...register('postCode')} />
            </Field>
            <Field id="wh-country" label="Country">
              <Input {...register('country')} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={watch('isDefault')}
              onCheckedChange={(c) => setValue('isDefault', c === true)}
            />
            <span>Default warehouse</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SimpleNameDialog({
  open,
  onOpenChange,
  title,
  initialName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = React.useState(initialName ?? '');
  const [pending, setPending] = React.useState(false);
  React.useEffect(() => {
    if (open) setName(initialName ?? '');
  }, [open, initialName]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setPending(true);
            try {
              await onSubmit(name.trim());
              onOpenChange(false);
            } finally {
              setPending(false);
            }
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="simple-name">Name</Label>
            <Input
              id="simple-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
