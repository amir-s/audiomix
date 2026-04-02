import * as React from "react"
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Select } from "radix-ui"

import { cn } from "@/lib/utils"

const SelectRoot = Select.Root
const SelectGroup = Select.Group

const SelectValue = React.forwardRef<
  React.ElementRef<typeof Select.Value>,
  React.ComponentPropsWithoutRef<typeof Select.Value>
>(({ className, ...props }, ref) => (
  <Select.Value
    className={cn("truncate", className)}
    data-slot="select-value"
    ref={ref}
    {...props}
  />
))

SelectValue.displayName = Select.Value.displayName

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof Select.Trigger>,
  React.ComponentPropsWithoutRef<typeof Select.Trigger>
>(({ className, children, ...props }, ref) => (
  <Select.Trigger
    className={cn(
      "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-border/70 bg-input/25 px-2.5 text-sm outline-none transition-[background-color,border-color,box-shadow] data-[placeholder]:text-muted-foreground hover:bg-input/45 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&_[data-slot=select-value]]:truncate",
      className
    )}
    data-slot="select-trigger"
    ref={ref}
    {...props}
  >
    {children}
    <Select.Icon className="shrink-0 text-muted-foreground">
      <HugeiconsIcon aria-hidden icon={ArrowDown01Icon} size={12} />
    </Select.Icon>
  </Select.Trigger>
))

SelectTrigger.displayName = Select.Trigger.displayName

const SelectContent = React.forwardRef<
  React.ElementRef<typeof Select.Content>,
  React.ComponentPropsWithoutRef<typeof Select.Content>
>(({ children, className, position = "popper", sideOffset = 8, ...props }, ref) => (
  <Select.Portal>
    <Select.Content
      className={cn(
        "z-50 max-h-80 min-w-[10rem] overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-lg outline-none",
        position === "popper" && "w-[var(--radix-select-trigger-width)]",
        className
      )}
      data-slot="select-content"
      position={position}
      ref={ref}
      sideOffset={sideOffset}
      {...props}
    >
      <Select.Viewport
        className={cn("p-1", position === "popper" && "w-full")}
        data-slot="select-viewport"
      >
        {children}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
))

SelectContent.displayName = Select.Content.displayName

const SelectItem = React.forwardRef<
  React.ElementRef<typeof Select.Item>,
  React.ComponentPropsWithoutRef<typeof Select.Item>
>(({ className, children, ...props }, ref) => (
  <Select.Item
    className={cn(
      "relative flex w-full cursor-pointer items-center rounded-md py-1.5 pr-7 pl-2.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[state=checked]:bg-muted/70 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    data-slot="select-item"
    ref={ref}
    {...props}
  >
    <Select.ItemText>{children}</Select.ItemText>
    <span className="absolute right-2.5 flex size-3.5 items-center justify-center text-foreground/80">
      <Select.ItemIndicator>
        <HugeiconsIcon aria-hidden icon={CheckmarkCircle02Icon} size={12} />
      </Select.ItemIndicator>
    </span>
  </Select.Item>
))

SelectItem.displayName = Select.Item.displayName

export {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectRoot as Select,
  SelectTrigger,
  SelectValue,
}
