import { type RefCallback } from "react"

import { type CompiledInstruction } from "@/lib/music-dsl"
import { cn } from "@/lib/utils"

import { getLabelColor } from "./label-colors"

type InstructionNodeProps = {
  instruction: CompiledInstruction
  isActive: boolean
  entryBadgeRef?: RefCallback<HTMLElement>
  exitBadgeRef?: RefCallback<HTMLElement>
}

export function InstructionNode({
  instruction,
  isActive,
  entryBadgeRef,
  exitBadgeRef,
}: InstructionNodeProps) {
  return (
    <div
      className={cn(
        "flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-lg border px-2 py-1.5 text-xs",
        isActive
          ? "border-emerald-400/70 bg-emerald-400/15 ring-2 ring-emerald-400/40"
          : "border-border/60 bg-muted/20"
      )}
      style={
        isActive
          ? undefined
          : {
              ...(instruction.fadeIn ? { borderLeftColor: "rgb(52 211 153 / 0.8)" } : {}),
              ...(instruction.fadeOut ? { borderRightColor: "rgb(251 191 36 / 0.8)" } : {}),
            }
      }
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
    </div>
  )
}
