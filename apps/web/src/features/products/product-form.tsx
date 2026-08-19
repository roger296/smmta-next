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
  // Auto-Stock item model + units of measure (spec §A3).
  itemKind: z.enum(['MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING']).default('RETAIL'),
  isSold: z.boolean().default(true),
  isStocked: z.boolean().default(true),
  barcode: z.string().max(64).optional().or(z.literal('')),
  referenceImageUrl: z.string().url().max(500).optional().or(z.literal('')),
  stockUom: z.string().max(20).optional().or(z.literal('')),
  purchaseUom: z.string().max(20).optional().or(z.literal('')),
  /** "25 kg sack", "case of 6 × 1.6 kg" — how the pack reads to a human. */
  packDescription: z.string().max(120).optional().or(z.literal('')),
  purchasePackSize: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
  purchaseToStockFactor: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
  /**
   * Counting quantum, in this product's own stock unit. Blank ⇒ null ⇒ counts
   * are submitted exactly as entered. Only fill this in where the venue
   * genuinely counts in a fixed increment — a blanket quantum turned a 4 kg
   * count into 0 (defect D-2).
   */
  countQuantum: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? null : v),
    z.coerce.number().positive().nullable(),
  ),
})
  /**
   * A purchase unit with a factor of 1 on a fungible product is the C-1 shape
   * exactly: icing sugar stocked in `g` with `purchaseToStockFactor` '1', so a
   * 25 kg sack rendered "= 1 g". It is *possible* (something genuinely bought
   * by the gram) but overwhelmingly it means the factor was never filled in,
   * so it has to be said out loud rather than saved silently.
   */
  .superRefine((values, ctx) => {
    const stockUom = (values.stockUom ?? '').trim().toLowerCase();
    const discrete = DISCRETE_UOMS.includes(stockUom);
    const factor = Number(values.purchaseToStockFactor ?? 1);
    if (!discrete && values.purchaseUom && factor === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['purchaseToStockFactor'],
        message: `1 ${values.purchaseUom} = 1 ${values.stockUom || 'stock unit'}? Set how many ${values.stockUom || 'stock units'} are in one ${values.purchaseUom}, or clear the purchase unit.`,
      });
    }
  });

/** Discrete (whole units, e.g. `each`) vs fungible (bulk, e.g. grams). */
const DISCRETE_UOMS = ['each', 'ea', 'unit', 'units', 'item', 'items', 'pcs', 'piece'];

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

  // Fungible products show the purchase→stock conversion fields.
  const stockUomVal = watch('stockUom');
  const isFungible = !!stockUomVal && !DISCRETE_UOMS.includes(stockUomVal.toLowerCase());

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

      {/* Auto-Stock: item model + units of measure (spec §A3) */}
      <div className="space-y-4 rounded-md border border-[var(--color-border)] p-4">
        <h3 className="text-sm font-medium">Stock &amp; units</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <Field id="p-itemKind" label="Item kind" error={errors.itemKind?.message}>
            <Select
              value={watch('itemKind')}
              onValueChange={(v) =>
                setValue('itemKind', v as ProductFormValues['itemKind'], { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="RETAIL">Retail (sold + stocked)</SelectItem>
                <SelectItem value="MERCH">Merch (sold + stocked)</SelectItem>
                <SelectItem value="INGREDIENT">Ingredient (stocked, not sold)</SelectItem>
                <SelectItem value="PACKAGING">Packaging (stocked, not sold)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="p-barcode" label="Barcode (GTIN)" error={errors.barcode?.message}>
            <Input {...register('barcode')} placeholder="defaults from EAN" />
          </Field>
          <Field id="p-tracking" label="Tracking">
            <Select
              value={isFungible ? 'FUNGIBLE' : 'DISCRETE'}
              onValueChange={(v) =>
                setValue('stockUom', v === 'FUNGIBLE' ? 'g' : 'each', { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DISCRETE">Discrete (whole units)</SelectItem>
                <SelectItem value="FUNGIBLE">Fungible (bulk)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {isFungible && (
          <div className="grid gap-4 md:grid-cols-4">
            <Field id="p-stockUom" label="Stock unit" error={errors.stockUom?.message}>
              <Input {...register('stockUom')} placeholder="g" />
            </Field>
            <Field id="p-purchaseUom" label="Purchase unit" error={errors.purchaseUom?.message}>
              <Input {...register('purchaseUom')} placeholder="sack" />
            </Field>
            <Field
              id="p-packDescription"
              label="Pack description"
              hint='How the pack reads on a delivery note — "25 kg sack", "case of 6 × 1.6 kg". The venue screens show this, not the bare unit.'
              error={errors.packDescription?.message}
            >
              <Input {...register('packDescription')} placeholder="25 kg sack" />
            </Field>
            <Field id="p-packSize" label="Pack size" error={errors.purchasePackSize?.message}>
              <Input type="number" step="any" {...register('purchasePackSize')} placeholder="1" />
            </Field>
            <Field
              id="p-factor"
              label="Stock units / purchase unit"
              error={errors.purchaseToStockFactor?.message}
            >
              <Input
                type="number"
                step="any"
                {...register('purchaseToStockFactor')}
                placeholder="1000"
              />
            </Field>
            <Field
              id="p-countQuantum"
              label="Count quantum (optional)"
              hint="Round stock-take counts of this product to the nearest N stock units. Leave blank to record counts exactly as entered — that is almost always right."
              error={errors.countQuantum?.message}
            >
              <Input
                type="number"
                step="any"
                {...register('countQuantum')}
                placeholder="none"
              />
            </Field>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={watch('isSold')}
              onCheckedChange={(c) => setValue('isSold', c === true)}
            />
            Sold (appears in BumbleBee revenue)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={watch('isStocked')}
              onCheckedChange={(c) => setValue('isStocked', c === true)}
            />
            Stocked (tracked on the stock ledger)
          </label>
        </div>
        <Field
          id="p-referenceImageUrl"
          label="Reference image URL"
          error={errors.referenceImageUrl?.message}
        >
          <Input {...register('referenceImageUrl')} placeholder="https://…" />
        </Field>
      </div>

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
