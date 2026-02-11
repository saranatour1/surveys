import * as React from 'react';
import { cn } from '@/lib/utils';

function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="radio-group" className={cn('flex flex-col gap-2', className)} {...props} />
  );
}

function RadioGroupItem({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="radio"
      data-slot="radio-group-item"
      className={cn(
        'border-input text-primary focus-visible:ring-ring/40 size-4 rounded-full border bg-background outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem };
