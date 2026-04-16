import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/forms/form-field';
import { MoneyInput } from '@/components/forms/money-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VAT_TREATMENTS, CURRENCIES } from '../_shared/vat-treatments';
import { useCustomerTypes } from './use-customers';

export const customerFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  shortName: z.string().max(50).optional().or(z.literal('')),
  typeId: z.string().uuid().optional().or(z.literal('')),
  email: z.string().email('Invalid email').max(100).optional().or(z.literal('')),
  creditLimit: z.coerce.number().min(0).default(0),
  creditCurrencyCode: z.string().length(3).default('GBP'),
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
});

export type CustomerFormValues = z.input<typeof customerFormSchema>;
export type CustomerFormOutput = z.output<typeof customerFormSchema>;

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>;
  onSubmit: (values: CustomerFormValues) => void | Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
}

export function CustomerForm({
  defaultValues,
  onSubmit,
  submitLabel = 'Save',
  onCancel,
}: CustomerFormProps) {
  const { data: customerTypes } = useCustomerTypes();
  const form = useForm<CustomerFormValues, unknown, CustomerFormOutput>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: {
      name: '',
      creditLimit: 0,
      creditCurrencyCode: 'GBP',
      creditTermDays: 30,
      taxRatePercent: 20,
      vatTreatment: 'STANDARD_VAT_20',
      ...defaultValues,
    },
  });
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = form;

  return (
    <form
      onSubmit={handleSubmit(async (v) => {
        // Strip empty strings so API sees undefined
        const cleaned: Record<string, unknown> = { ...(v as unknown as Record<string, unknown>) };
        for (const k of Object.keys(cleaned)) {
          if (cleaned[k] === '') delete cleaned[k];
        }
        await onSubmit(cleaned as CustomerFormValues);
      })}
      className="space-y-4"
      aria-label="Customer form"
    >
      <Field id="c-name" label="Name" required error={errors.name?.message}>
        <Input {...register('name')} placeholder="Acme Ltd" />
      </Field>

      <Field id="c-shortName" label="Short name" error={errors.shortName?.message}>
        <Input {...register('shortName')} placeholder="Acme" />
      </Field>

      <Field id="c-email" label="Email" error={errors.email?.message}>
        <Input type="email" {...register('email')} placeholder="billing@acme.com" />
      </Field>

      <Field id="c-type" label="Customer type" error={errors.typeId?.message}>
        <Select
          value={watch('typeId') ?? ''}
          onValueChange={(v) => setValue('typeId', v || undefined, { shouldValidate: true })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select type (optional)" />
          </SelectTrigger>
          <SelectContent>
            {customerTypes?.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="c-creditLimit"
          label="Credit limit"
          error={errors.creditLimit?.message}
        >
          <MoneyInput {...register('creditLimit')} currencySymbol="£" />
        </Field>
        <Field
          id="c-creditCurrencyCode"
          label="Currency"
          error={errors.creditCurrencyCode?.message}
        >
          <Select
            value={watch('creditCurrencyCode')}
            onValueChange={(v) => setValue('creditCurrencyCode', v, { shouldValidate: true })}
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

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          id="c-creditTermDays"
          label="Credit term (days)"
          error={errors.creditTermDays?.message}
        >
          <Input type="number" min={0} {...register('creditTermDays')} />
        </Field>
        <Field
          id="c-taxRatePercent"
          label="Tax rate (%)"
          error={errors.taxRatePercent?.message}
        >
          <Input type="number" min={0} max={100} step={0.01} {...register('taxRatePercent')} />
        </Field>
      </div>

      <Field
        id="c-vatTreatment"
        label="VAT treatment"
        required
        error={errors.vatTreatment?.message}
      >
        <Select
          value={watch('vatTreatment')}
          onValueChange={(v) => setValue('vatTreatment', v as CustomerFormValues['vatTreatment'], { shouldValidate: true })}
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
        <Field
          id="c-vatRegistrationNumber"
          label="VAT number"
          error={errors.vatRegistrationNumber?.message}
        >
          <Input {...register('vatRegistrationNumber')} placeholder="GB123456789" />
        </Field>
        <Field id="c-countryCode" label="Country code" error={errors.countryCode?.message}>
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
