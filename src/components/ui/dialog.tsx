import * as React from 'react';
import { cn } from '@/lib/utils';

function Dialog({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">{children}</div>
  );
}

function DialogContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-content"
      className={cn('bg-card text-card-foreground w-full max-w-lg rounded-lg border p-4 shadow-lg', className)}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('mb-3 flex flex-col gap-1', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 data-slot="dialog-title" className={cn('text-base font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p data-slot="dialog-description" className={cn('text-muted-foreground text-xs/relaxed', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('mt-4 flex items-center justify-end gap-2', className)} {...props} />;
}

export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle };
