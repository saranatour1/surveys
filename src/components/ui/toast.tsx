import * as React from 'react';
import { cn } from '@/lib/utils';

function Toast({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="toast"
      className={cn('bg-card text-card-foreground border-border rounded-md border px-3 py-2 shadow-sm', className)}
      {...props}
    />
  );
}

export { Toast };
