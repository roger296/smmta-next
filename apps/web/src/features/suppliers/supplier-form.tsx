import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/money-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VAT_TREATMENTS, CURRENCIES } from '../_shared/vat-treatments';

export const supplierFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  type: z.string().max(100).optional().or(z.literal('')),
  email: z.string().email('Invalid email').max(200).optional().or(z.literal('')),
  accountsEmail: z.string().email('Invalid email').max(200).optional().or(z.literal('')),
  website: z.string().url('Invalid URL').max(500).optional().or(z.literal('')),
  currencyCode: z.string().length(3).default('GBP'),
  creditLimit: z.coerce.number().min(0).default(0),
  creditTermDays: z.coerce.number().int().min(0).default(30),
  taxRatePercent: z.coerce.number().min(0).max(100).default(20),
  vatTreatment: z.enum([
    'STANDARD_VAT_20',
    'REDUCED_VAT_5',
    'ZERO_RATED',
    'EXEMPT',
    'OUTSIDE_SCOPE',
    'REVERSE_CHARGE',
    'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  vatRegistrationNumber: z.string().max(50).optional().or(z.literal('')),
  countryCode: z.string().max(3).optional().or(z.literal('')),
  leadTimeDays: z.coerce.number().int().min(0).optional(),
});

export type SupplierFormValues = z.input<typeof supplierFormSchema>;
export type SupplierFormOutput = z.output<typeof supplierFormSchema>;

interface Props {
  defaultValues?: Partial<SupplierFormValues>;
  onSubmit: (v: SupplierFormValues) => void | Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
}

export function SupplierForm({ defaultValues, onSubmit, submitLabel = 'Save', onCancel }: Props) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SupplierFormValues, unknown, SupplierFormOutput>({
    resolver: zodResolver(supplierFormSchema),
    defaultValues: {
      name: '',
      currencyCode: 'GBP',
      creditLimit: 0,
      creditTermDays: 30,
      taxRatePercent: 20,
      vatTreatment: 'STANDARD_VAT_20',
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
        await onSubmit(cleaned as SupplierFormValues);
      })}
      aria-label="Supplier form"
      className="space-y-4"
    >
      <Field id="s-name" label="Name" required error={errors.name?.message}>
        <Input {...register('name')} />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="s-type" label="Type / category" error={errors.type?.message}>
          <Input {...register('type')} placeholder="e.g. Wholesaler" />
        </Field>
        <Field id="s-website" label="Website" error={errors.website?.message}>
          <Input {...register('website')} placeholder="https://..." />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="s-email" label="Email" error={errors.email?.message}>
          <Input type="email" {...register('email')} />
        </Field>
        <Field id="s-accountsEmail" label="Accounts email" error={errors.accountsEmail?.message}>
          <Input type="email" {...register('accountsEmail')} />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="s-creditLimit" label="Credit limit" error={errors.creditLimit?.message}>
          <MoneyInput {...register('creditLimit')} currencySymbol="£" />
        </Field>
        <Field id="s-currencyCode" label="Currency" error={errors.currencyCode?.message}>
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
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Field id="s-creditTermDays" label="Credit term (days)" error={errors.creditTermDays?.message}>
          <Input type="number" min={0} {...register('creditTermDays')} />
        </Field>
        <Field id="s-taxRatePercent" label="Tax rate (%)" error={errors.taxRatePercent?.message}>
          <Input type="number" min={0} max={100} step={0.01} {...register('taxRatePercent')} />
        </Field>
        <Field id="s-leadTimeDays" label="Lead time (days)" error={errors.leadTimeDays?.message}>
          <Input type="number" min={0} {...register('leadTimeDays')} />
        </Field>
      </div>

      <Field id="s-vatTreatment" label="VAT treatment" required error={errors.vatTreatment?.message}>
        <Select
          value={watch('vatTreatment')}
          onValueChange={(v) => setValue('vatTreatment', v as SupplierFormValues['vatTreatment'], { shouldValidate: true })}
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

      <div className="grid gap-4 md:grid-cols-2">
        <Field id="s-vatRegistrationNumber" label="VAT number" error={errors.vatRegistrationNumber?.message}>
          <Input {...register('vatRegistrationNumber')} />
        </Field>
        <Field id="s-countryCode" label="Country code" error={errors.countryCode?.message}>
          <Input maxLength={3} {...register('countryCode')} placeholder="GB" />
        </Field>
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
