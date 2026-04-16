import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      'fixed bottom-0 right-0 z-50 flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-[420px]',
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = 'ToastViewport';

export interface ToastVariant {
  variant?: 'default' | 'destructive';
}

export const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & ToastVariant
>(({ className, variant = 'default', ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(
      'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-md border p-4 pr-8 shadow-lg',
      variant === 'destructive'
        ? 'border-[var(--color-destructive)] bg-[var(--color-destructive)] text-[var(--color-destructive-foreground)]'
        : 'border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)]',
      className,
    )}
    {...props}
  />
));
Toast.displayName = 'Toast';

export const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
));
ToastTitle.displayName = 'ToastTitle';

export const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn('text-sm opacity-90', className)}
    {...props}
  />
));
ToastDescription.displayName = 'ToastDescription';

export const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn('absolute right-2 top-2 rounded-md p-1 opacity-60 hover:opacity-100', className)}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = 'ToastClose';
