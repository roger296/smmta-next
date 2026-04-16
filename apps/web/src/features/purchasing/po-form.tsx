import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/money-input';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { VAT_TREATMENTS, CURRENCIES } from '../_shared/vat-treatments';
import { useSuppliersList } from '../suppliers/use-suppliers';
import { useProductsList } from '../products/use-products';
import { useWarehouses } from '../reference/use-reference';
import { formatMoney } from '@/lib/format';
import { Plus, Trash2 } from 'lucide-react';

export const poFormSchema = z.object({
  supplierId: z.string().uuid('Select a supplier'),
  deliveryWarehouseId: z.string().uuid().optional().or(z.literal('')),
  currencyCode: z.string().length(3).default('GBP'),
  deliveryCharge: z.coerce.number().min(0).default(0),
  exchangeRate: z.coerce.number().min(0.01).default(1),
  vatTreatment: z.enum([
    'STANDARD_VAT_20',
    'REDUCED_VAT_5',
    'ZERO_RATED',
    'EXEMPT',
    'OUTSIDE_SCOPE',
    'REVERSE_CHARGE',
    'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid('Select a product'),
        quantity: z.coerce.number().min(0.01, 'Qty must be > 0'),
        pricePerUnit: z.coerce.number().min(0),
        taxRate: z.coerce.number().min(0).max(100).default(20),
      }),
    )
    .min(1, 'Add at least one line'),
});

export type POFormValues = z.input<typeof poFormSchema>;
export type POFormOutput = z.output<typeof poFormSchema>;

interface Props {
  defaultValues?: Partial<POFormValues>;
  onSubmit: (v: POFormOutput) => void | Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
}

export function POForm({ defaultValues, onSubmit, submitLabel = 'Create PO', onCancel }: Props) {
  const { data: suppliers } = useSuppliersList({ pageSize: 200 });
  const { data: products } = useProductsList({ pageSize: 500 });
  const { data: warehouses } = useWarehouses();

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<POFormValues, unknown, POFormOutput>({
    resolver: zodResolver(poFormSchema),
    defaultValues: {
      currencyCode: 'GBP',
      deliveryCharge: 0,
      exchangeRate: 1,
      vatTreatment: 'STANDARD_VAT_20',
      lines: [{ productId: '', quantity: 1, pricePerUnit: 0, taxRate: 20 }],
      ...defaultValues,
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  const lines = watch('lines');
  const deliveryCharge = Number(watch('deliveryCharge') ?? 0);
  const subtotal = (lines ?? []).reduce(
    (s, l) => s + Number(l.quantity ?? 0) * Number(l.pricePerUnit ?? 0),
    0,
  );
  const tax = (lines ?? []).reduce(
    (s, l) => s + Number(l.quantity ?? 0) * Number(l.pricePerUnit ?? 0) * (Number(l.taxRate ?? 0) / 100),
    0,
  );
  const total = subtotal + tax + deliveryCharge;

  return (
    <form
      onSubmit={handleSubmit(async (v) => {
        const cleaned: Record<string, unknown> = { ...(v as unknown as Record<string, unknown>) };
        for (const k of Object.keys(cleaned)) {
          if (cleaned[k] === '') delete cleaned[k];
        }
        await onSubmit(cleaned as unknown as POFormOutput);
      })}
      className="space-y-6"
      aria-label="Purchase order form"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="po-supplier" label="Supplier" required error={errors.supplierId?.message}>
          <Select
            value={watch('supplierId') ?? ''}
            onValueChange={(v) => setValue('supplierId', v, { shouldValidate: true })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select supplier" />
            </SelectTrigger>
            <SelectContent>
              {suppliers?.data.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="po-warehouse" label="Delivery warehouse">
          <Select
            value={watch('deliveryWarehouseId') ?? ''}
            onValueChange={(v) =>
              setValue('deliveryWarehouseId', v || undefined, { shouldValidate: true })
            }
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
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Field id="po-currencyCode" label="Currency">
          <Select
            value={watch('currencyCode')}
            onValueChange={(v) => setValue('currencyCode', v, { shouldValidate: true })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="po-exchangeRate" label="Exchange rate">
          <Input type="number" step="0.0001" min={0.01} {...register('exchangeRate')} />
        </Field>
        <Field id="po-deliveryCharge" label="Delivery charge">
          <MoneyInput {...register('deliveryCharge')} currencySymbol="£" />
        </Field>
        <Field id="po-expectedDelivery" label="Expected delivery">
          <Input type="date" {...register('expectedDeliveryDate')} />
        </Field>
      </div>

      <Field id="po-vatTreatment" label="VAT treatment">
        <Select
          value={watch('vatTreatment')}
          onValueChange={(v) => setValue('vatTreatment', v as POFormValues['vatTreatment'], { shouldValidate: true })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VAT_TREATMENTS.map((vt) => (
              <SelectItem key={vt.value} value={vt.value}>
                {vt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-medium">Line items</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              append({ productId: '', quantity: 1, pricePerUnit: 0, taxRate: 20 })
            }
          >
            <Plus className="h-4 w-4" />
            Add line
          </Button>
        </div>
        {errors.lines?.message && (
          <p role="alert" className="text-xs text-[var(--color-destructive)]">
            {errors.lines.message}
          </p>
        )}
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Qty</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">Unit cost</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Tax %</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">Line total</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {fields.map((field, i) => {
                  const line = lines?.[i];
                  const lineTotal = Number(line?.quantity ?? 0) * Number(line?.pricePerUnit ?? 0);
                  return (
                    <tr key={field.id} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-3 py-2">
                        <Select
                          value={line?.productId ?? ''}
                          onValueChange={(v) =>
                            setValue(`lines.${i}.productId`, v, { shouldValidate: true })
                          }
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
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          min={0.01}
                          {...register(`lines.${i}.quantity`)}
                          aria-label={`Line ${i + 1} quantity`}
                          className="text-right"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          {...register(`lines.${i}.pricePerUnit`)}
                          aria-label={`Line ${i + 1} unit cost`}
                          className="text-right"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          min={0}
                          max={100}
                          {...register(`lines.${i}.taxRate`)}
                          aria-label={`Line ${i + 1} tax rate`}
                          className="text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium">{formatMoney(lineTotal)}</td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={fields.length === 1}
                          onClick={() => remove(i)}
                          aria-label={`Remove line ${i + 1}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <div className="min-w-[280px] space-y-1 text-sm">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatMoney(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tax</span>
            <span>{formatMoney(tax)}</span>
          </div>
          <div className="flex justify-between">
            <span>Delivery</span>
            <span>{formatMoney(deliveryCharge)}</span>
          </div>
          <div className="flex justify-between border-t border-[var(--color-border)] pt-1 text-base font-semibold">
            <span>Total</span>
            <span>{formatMoney(total)}</span>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
