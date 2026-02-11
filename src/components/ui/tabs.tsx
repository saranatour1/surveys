import * as React from 'react';
import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />;
}

function TabsList({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="tabs-list" className={cn('inline-flex w-fit rounded-md border p-1', className)} {...props} />;
}

function TabsTrigger({ className, active = false, ...props }: React.ComponentProps<'button'> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="tabs-trigger"
      data-active={active}
      className={cn(
        'rounded-sm px-3 py-1 text-xs/relaxed transition-colors data-[active=true]:bg-primary data-[active=true]:text-primary-foreground',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="tabs-content" className={cn('focus-visible:ring-ring/40 rounded-md outline-none focus-visible:ring-2', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
