import * as React from 'react';
import { Input } from '@/components/ui/input';

interface MoneyInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  currencySymbol?: string;
}

/** Numeric input accepting up to 2 decimal places. Value stored as string. */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ currencySymbol, ...props }, ref) => {
    return (
      <div className="relative">
        {currencySymbol && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-muted-foreground)]">
            {currencySymbol}
          </span>
        )}
        <Input
          ref={ref}
          type="number"
          step="0.01"
          min={0}
          className={currencySymbol ? 'pl-7' : undefined}
          {...props}
        />
      </div>
    );
  },
);
MoneyInput.displayName = 'MoneyInput';
