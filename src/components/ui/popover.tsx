import * as React from "react"
import { Popover } from "radix-ui"

import { cn } from "@/lib/utils"

const PopoverRoot = Popover.Root
const PopoverTrigger = Popover.Trigger
const PopoverAnchor = Popover.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof Popover.Content>,
  React.ComponentPropsWithoutRef<typeof Popover.Content>
>(({ align = "center", className, sideOffset = 8, ...props }, ref) => (
  <Popover.Portal>
    <Popover.Content
      align={align}
      className={cn(
        "z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border/70 bg-popover p-4 text-popover-foreground shadow-lg outline-none",
        className
      )}
      ref={ref}
      sideOffset={sideOffset}
      {...props}
    />
  </Popover.Portal>
))

PopoverContent.displayName = Popover.Content.displayName

export {
  PopoverAnchor,
  PopoverContent,
  PopoverRoot as Popover,
  PopoverTrigger,
}
