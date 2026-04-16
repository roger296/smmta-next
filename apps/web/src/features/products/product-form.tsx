import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/money-input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useManufacturers, useWarehouses } from '../reference/use-reference';
import { useSuppliersList } from '../suppliers/use-suppliers';

export const productFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(500),
  stockCode: z.string().max(100).optional().or(z.literal('')),
  manufacturerId: z.string().uuid().optional().or(z.literal('')),
  manufacturerPartNumber: z.string().max(100).optional().or(z.literal('')),
  description: z.string().optional().or(z.literal('')),
  expectedNextCost: z.coerce.number().min(0).default(0),
  minSellingPrice: z.coerce.number().min(0).optional(),
  maxSellingPrice: z.coerce.number().min(0).optional(),
  ean: z.string().max(50).optional().or(z.literal('')),
  productType: z.enum(['PHYSICAL', 'SERVICE']).default('PHYSICAL'),
  requireSerialNumber: z.boolean().default(false),
  requireBatchNumber: z.boolean().default(false),
  weight: z.coerce.number().min(0).optional(),
  countryOfOrigin: z.string().max(3).optional().or(z.literal('')),
  hsCode: z.string().max(20).optional().or(z.literal('')),
  supplierId: z.string().uuid().optional().or(z.literal('')),
  defaultWarehouseId: z.string().uuid().optional().or(z.literal('')),
});

export type ProductFormValues = z.input<typeof productFormSchema>;
export type ProductFormOutput = z.output<typeof productFormSchema>;

interface Props {
  defaultValues?: Partial<ProductFormValues>;
  onSubmit: (v: ProductFormValues) => void | Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
}

export function ProductForm({ defaultValues, onSubmit, submitLabel = 'Save', onCancel }: Props) {
  const { data: manufacturers } = useManufacturers();
  const { data: warehouses } = useWarehouses();
  const { data: suppliers } = useSuppliersList({ pageSize: 100 });
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormValues, unknown, ProductFormOutput>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      name: '',
      expectedNextCost: 0,
      productType: 'PHYSICAL',
      requireSerialNumber: false,
      requireBatchNumber: false,
      ...defaultValues,
    },
  });

  return (
    <form
      onSubmit={handleSubmit(async (v) => {
        const cleaned: Record<string, unknown> = { ...(v as unknown as Record<string, unknown>) };
        for (const k of Object.keys(cleaned)) {
          if (cleaned[k] === '') delete cleaned[k];
        }
        await onSubmit(cleaned as ProductFormValues);
      })}
      aria-label="Product form"
      className="space-y-4"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="p-name" label="Name" required error={errors.name?.message}>
          <Input {...register('name')} />
        </Field>
        <Field id="p-stockCode" label="Stock code" error={errors.stockCode?.message}>
          <Input {...register('stockCode')} placeholder="SKU-001" />
        </Field>
      </div>

      <Field id="p-description" label="Description" error={errors.description?.message}>
        <Textarea {...register('description')} rows={3} />
      </Field>

      <div className="grid gap-4 md:grid-cols-3">
        <Field
          id="p-expectedNextCost"
          label="Expected next cost"
          error={errors.expectedNextCost?.message}
        >
          <MoneyInput {...register('expectedNextCost')} currencySymbol="£" />
        </Field>
        <Field
          id="p-minSellingPrice"
          label="Min selling price"
          error={errors.minSellingPrice?.message}
        >
          <MoneyInput {...register('minSellingPrice')} currencySymbol="£" />
        </Field>
        <Field
          id="p-maxSellingPrice"
          label="Max selling price"
          error={errors.maxSellingPrice?.message}
        >
          <MoneyInput {...register('maxSellingPrice')} currencySymbol="£" />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="p-productType" label="Product type" error={errors.productType?.message}>
          <Select
            value={watch('productType')}
            onValueChange={(v) => setValue('productType', v as ProductFormValues['productType'], { shouldValidate: true })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PHYSICAL">Physical</SelectItem>
              <SelectItem value="SERVICE">Service</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="p-ean" label="EAN / Barcode" error={errors.ean?.message}>
          <Input {...register('ean')} />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="p-manufacturer" label="Manufacturer" error={errors.manufacturerId?.message}>
          <Select
            value={watch('manufacturerId') ?? ''}
            onValueChange={(v) => setValue('manufacturerId', v || undefined, { shouldValidate: true })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select manufacturer" />
            </SelectTrigger>
            <SelectContent>
              {manufacturers?.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="p-supplier" label="Default supplier" error={errors.supplierId?.message}>
          <Select
            value={watch('supplierId') ?? ''}
            onValueChange={(v) => setValue('supplierId', v || undefined, { shouldValidate: true })}
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
      </div>

      <Field
        id="p-defaultWarehouse"
        label="Default warehouse"
        error={errors.defaultWarehouseId?.message}
      >
        <Select
          value={watch('defaultWarehouseId') ?? ''}
          onValueChange={(v) => setValue('defaultWarehouseId', v || undefined, { shouldValidate: true })}
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

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={watch('requireSerialNumber')}
            onCheckedChange={(c) => setValue('requireSerialNumber', c === true)}
          />
          Require serial numbers
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={watch('requireBatchNumber')}
            onCheckedChange={(c) => setValue('requireBatchNumber', c === true)}
          />
          Require batch numbers
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-4">
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
