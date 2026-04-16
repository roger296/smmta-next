import * as React from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

interface FieldProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** Simple wrapper around Label + control + hint + error message. */
export function Field({ id, label, required, hint, error, className, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-[var(--color-destructive)]">*</span>}
      </Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id,
            'aria-invalid': !!error,
            'aria-describedby': [errorId, hintId].filter(Boolean).join(' ') || undefined,
          })
        : children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[var(--color-muted-foreground)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--color-destructive)]">
          {error}
        </p>
      )}
    </div>
  );
}
