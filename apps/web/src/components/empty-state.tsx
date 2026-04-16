import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <Card className={className}>
      <CardContent
        className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center')}
      >
        <Icon className="h-12 w-12 text-[var(--color-muted-foreground)]" aria-hidden />
        <p className="text-base font-medium">{title}</p>
        {description && (
          <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p>
        )}
        {action && <div className="mt-2">{action}</div>}
      </CardContent>
    </Card>
  );
}
