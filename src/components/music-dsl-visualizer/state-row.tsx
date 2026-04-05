import { type RefCallback } from "react"

import { Button } from "@/components/ui/button"
import {
  getInstructionIdentity,
  type CompiledState,
  type MusicDslInstructionIdentity,
} from "@/lib/music-dsl"
import { cn } from "@/lib/utils"

import { InstructionNode } from "./instruction-node"

type LoopRange = { from: number; to: number }

function getLoopRanges(state: CompiledState): LoopRange[] {
  const ranges: LoopRange[] = []
  for (const instr of state.instructions) {
    if (instr.loopTo !== null) {
      ranges.push({ from: instr.loopTo, to: instr.position })
    }
  }
  return ranges
}

type StateRowProps = {
  state: CompiledState
  isActive: boolean
  isPending: boolean
  activeInstructionIndex: number | null
  selectedInstruction?: MusicDslInstructionIdentity | null
  onInstructionClick?: (
    instruction: MusicDslInstructionIdentity,
    options?: { connect?: boolean; force?: boolean }
  ) => void
  onStateClick?: (stateName: string, options?: { force?: boolean }) => void
  registerBadgeRef: (key: string) => RefCallback<HTMLElement>
}

export function StateRow({
  state,
  isActive,
  isPending,
  activeInstructionIndex,
  selectedInstruction,
  onInstructionClick,
  onStateClick,
  registerBadgeRef,
}: StateRowProps) {
  const loopRanges = getLoopRanges(state)

  // Build segments: groups of instructions, some wrapped in a loop box
  type Segment =
    | { type: "single"; instr: (typeof state.instructions)[number] }
    | { type: "loop"; instrs: (typeof state.instructions)[number][] }

  const segments: Segment[] = []
  let i = 0
  while (i < state.instructions.length) {
    const instr = state.instructions[i]
    const loop = loopRanges.find((r) => r.from === instr.position)
    if (loop) {
      const loopInstrs: (typeof state.instructions)[number][] = []
      while (i < state.instructions.length && state.instructions[i].position <= loop.to) {
        loopInstrs.push(state.instructions[i])
        i++
      }
      segments.push({ type: "loop", instrs: loopInstrs })
    } else {
      segments.push({ type: "single", instr })
      i++
    }
  }

  function renderNode(instr: (typeof state.instructions)[number]) {
    const instructionIdentity = getInstructionIdentity(state.name, instr)

    return (
      <div key={instr.position}>
        <InstructionNode
          instruction={instr}
          isActive={isActive && activeInstructionIndex === instr.position}
          isSelected={
            selectedInstruction?.stateName === instructionIdentity.stateName &&
            selectedInstruction.sourceElementKey ===
              instructionIdentity.sourceElementKey &&
            selectedInstruction.sourceOccurrenceIndex ===
              instructionIdentity.sourceOccurrenceIndex
          }
          entryBadgeRef={
            instr.entryLabel
              ? registerBadgeRef(`${state.name}:${instr.position}:entry`)
              : undefined
          }
          exitBadgeRef={
            instr.exitLabel
              ? registerBadgeRef(`${state.name}:${instr.position}:exit`)
              : undefined
          }
          onClick={(event) => {
            onInstructionClick?.(instructionIdentity, {
              connect: event.altKey,
              force: event.metaKey || event.ctrlKey,
            })
          }}
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border-l-2 py-2 pl-3 pr-2",
        isActive
          ? "border-l-emerald-400 bg-emerald-400/5"
          : isPending
            ? "border-l-amber-400 bg-amber-400/5"
            : "border-l-transparent"
      )}
    >
      <Button
        className="h-auto min-h-8 w-24 shrink-0 justify-start px-2 py-1.5 text-left text-xs whitespace-normal"
        onClick={(event) => {
          onStateClick?.(state.name, {
            force: event.metaKey || event.ctrlKey,
          })
        }}
        title="Click to queue goTo. Cmd/Ctrl+Click force-starts this state."
        type="button"
        variant={isActive ? "default" : isPending ? "secondary" : "ghost"}
      >
        {state.name}
      </Button>

      <div className="flex items-start gap-1.5">
        {segments.map((seg) => {
          if (seg.type === "single") {
            return renderNode(seg.instr)
          }
          return (
            <div
              key={`loop-${seg.instrs[0].position}`}
              className="flex items-start gap-1.5 rounded-lg border border-dashed border-muted-foreground/25 bg-muted/10 px-1.5 py-1.5"
            >
              {seg.instrs.map(renderNode)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
