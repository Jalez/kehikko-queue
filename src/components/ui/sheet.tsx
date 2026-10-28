import * as SheetPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/*
 * shadcn's Sheet (a drawer) over Radix Dialog: focus is trapped inside while it is open, Esc and the
 * overlay close it, and focus goes back to the button that opened it. It comes from the side, and
 * from the bottom below 640 px, where a side drawer would leave no page to speak of.
 */

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root {...props} />
}

function SheetContent({ className, children, ...props }: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <SheetPrimitive.Content
        className={cn(
          'bg-background text-foreground fixed z-50 flex flex-col gap-2 p-4 shadow-lg outline-none',
          'inset-x-0 bottom-0 max-h-[85vh] rounded-t-lg border-t',
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[30rem] sm:max-w-[90vw] sm:rounded-none sm:border-t-0 sm:border-l',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="ring-offset-background focus-visible:ring-ring absolute top-3 right-3 rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:outline-none" aria-label="Close">
          <X className="size-4" />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('pr-6 text-base font-semibold break-words', className)} {...props} />
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-muted-foreground text-xs', className)} {...props} />
}

export { Sheet, SheetContent, SheetDescription, SheetTitle }
