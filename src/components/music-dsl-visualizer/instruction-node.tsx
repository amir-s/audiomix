import { type MouseEventHandler, type RefCallback } from "react"

import { type CompiledInstruction } from "@/lib/music-dsl"
import { cn } from "@/lib/utils"

import { getLabelColor } from "./label-colors"

type InstructionNodeProps = {
  instruction: CompiledInstruction
  isActive: boolean
  isSelected: boolean
  entryBadgeRef?: RefCallback<HTMLElement>
  exitBadgeRef?: RefCallback<HTMLElement>
  onClick?: MouseEventHandler<HTMLButtonElement>
}

export function InstructionNode({
  instruction,
  isActive,
  isSelected,
  entryBadgeRef,
  exitBadgeRef,
  onClick,
}: InstructionNodeProps) {
  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "flex w-[72px] shrink-0 cursor-pointer flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        isActive && isSelected
          ? "border-emerald-400/80 bg-emerald-400/15 ring-2 ring-sky-400/45"
          : isActive
            ? "border-emerald-400/70 bg-emerald-400/15 ring-2 ring-emerald-400/40"
            : isSelected
              ? "border-sky-400/70 bg-sky-400/10 ring-2 ring-sky-400/35"
              : "border-border/60 bg-muted/20 hover:bg-muted/30"
      )}
      onClick={onClick}
      style={
        isActive || isSelected
          ? undefined
          : {
              ...(instruction.fadeIn ? { borderLeftColor: "rgb(52 211 153 / 0.8)" } : {}),
              ...(instruction.fadeOut ? { borderRightColor: "rgb(251 191 36 / 0.8)" } : {}),
            }
      }
      title="Click to select. Cmd/Ctrl+Click plays from here. Option/Alt+Click connects from the selected node."
      type="button"
    >
      {instruction.entryLabel ? (
        <span
          ref={entryBadgeRef}
          className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none"
          style={{
            backgroundColor: getLabelColor(instruction.entryLabel) + "22",
            color: getLabelColor(instruction.entryLabel),
          }}
        >
          {`{${instruction.entryLabel}}`} <span className="ml-0.5 opacity-60">&#x2192;</span>
        </span>
      ) : (
        <span className="h-[16px]" />
      )}

      <span className="text-sm font-semibold tabular-nums text-foreground">
        {instruction.section}
      </span>

      {instruction.exitLabel ? (
        <span
          ref={exitBadgeRef}
          className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none"
          style={{
            backgroundColor: getLabelColor(instruction.exitLabel) + "22",
            color: getLabelColor(instruction.exitLabel),
          }}
        >
          <span className="mr-0.5 opacity-60">&#x2192;</span> {`{${instruction.exitLabel}}`}
        </span>
      ) : (
        <span className="h-[16px]" />
      )}

      <div className="flex h-[14px] items-center gap-1.5 text-[10px]">
        {instruction.fadeIn && (
          <span className="text-emerald-400" title="Fade in">
            &gt;in
          </span>
        )}
        {instruction.fadeOut && (
          <span className="text-amber-400" title="Fade out">
            out&gt;
          </span>
        )}
      </div>
    </button>
  )
}
