import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/money-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProductsList } from '@/features/products/use-products';
import { useWarehouses } from '@/features/reference/use-reference';
import { useAdjustStock } from '@/features/stock/use-stock';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/stock/adjust')({
  component: StockAdjustPage,
});

const schema = z.object({
  productId: z.string().uuid('Select a product'),
  warehouseId: z.string().uuid('Select a warehouse'),
  type: z.enum(['ADD', 'REMOVE']),
  quantity: z.coerce.number().int().min(1, 'Must be at least 1'),
  valuePerUnit: z.coerce.number().min(0, 'Cannot be negative'),
  reason: z.string().min(1, 'Reason is required').max(500),
  serialNumbers: z.string().optional(),
});
type FormValues = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

function StockAdjustPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: products } = useProductsList({ pageSize: 500 });
  const { data: warehouses } = useWarehouses();
  const mutation = useAdjustStock();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'ADD', quantity: 1, valuePerUnit: 0, reason: '' },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Adjust stock</h1>
      <Card>
        <CardHeader>
          <CardTitle>Adjustment details</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit(async (v) => {
              const serialNumbers = v.serialNumbers
                ? v.serialNumbers.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
                : undefined;
              try {
                await mutation.mutateAsync({
                  productId: v.productId,
                  warehouseId: v.warehouseId,
                  type: v.type,
                  quantity: v.quantity,
                  valuePerUnit: v.valuePerUnit,
                  reason: v.reason,
                  serialNumbers,
                });
                toast({ title: 'Stock adjusted' });
                navigate({ to: '/stock' });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            })}
            className="space-y-4"
            aria-label="Stock adjustment form"
          >
            <Field id="adj-product" label="Product" required error={errors.productId?.message}>
              <Select
                value={watch('productId') ?? ''}
                onValueChange={(v) => setValue('productId', v, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {products?.data.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="adj-warehouse" label="Warehouse" required error={errors.warehouseId?.message}>
              <Select
                value={watch('warehouseId') ?? ''}
                onValueChange={(v) => setValue('warehouseId', v, { shouldValidate: true })}
              >
                <SelectTrigger>
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
            </Field>
            <div className="grid gap-4 md:grid-cols-3">
              <Field id="adj-type" label="Type" required error={errors.type?.message}>
                <Select
                  value={watch('type')}
                  onValueChange={(v) => setValue('type', v as 'ADD' | 'REMOVE', { shouldValidate: true })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADD">Add to stock</SelectItem>
                    <SelectItem value="REMOVE">Remove from stock</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field id="adj-qty" label="Quantity" required error={errors.quantity?.message}>
                <Input type="number" min={1} step={1} {...register('quantity')} />
              </Field>
              <Field id="adj-value" label="Value / unit" required error={errors.valuePerUnit?.message}>
                <MoneyInput currencySymbol="£" {...register('valuePerUnit')} />
              </Field>
            </div>
            <Field id="adj-serials" label="Serial numbers" hint="Optional — comma or newline separated">
              <Textarea {...register('serialNumbers')} rows={2} />
            </Field>
            <Field id="adj-reason" label="Reason" required error={errors.reason?.message}>
              <Textarea {...register('reason')} rows={2} placeholder="e.g. Stock count correction" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate({ to: '/stock' })}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Adjusting…' : 'Apply adjustment'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
