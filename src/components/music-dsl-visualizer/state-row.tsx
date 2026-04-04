import { type RefCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { type CompiledState } from "@/lib/music-dsl"
import { cn } from "@/lib/utils"

import { InstructionNode } from "./instruction-node"

type StateRowProps = {
  state: CompiledState
  isActive: boolean
  isPending: boolean
  activeInstructionIndex: number | null
  onStateClick?: (stateName: string, options?: { force?: boolean }) => void
  registerBadgeRef: (key: string) => RefCallback<HTMLElement>
}

type LoopPathData = { d: string; endX: number; endY: number }

function measureLoopPaths(
  state: CompiledState,
  rowEl: HTMLElement,
  nodeEls: Map<number, HTMLElement | null>
): LoopPathData[] {
  const rowRect = rowEl.getBoundingClientRect()
  const paths: LoopPathData[] = []

  for (const instr of state.instructions) {
    if (instr.loopTo === null) continue

    const fromEl = nodeEls.get(instr.position)
    const toEl = nodeEls.get(instr.loopTo)
    if (!fromEl || !toEl) continue

    const fromRect = fromEl.getBoundingClientRect()
    const toRect = toEl.getBoundingClientRect()

    const fromX = fromRect.left + fromRect.width / 2 - rowRect.left
    const toX = toRect.left + toRect.width / 2 - rowRect.left
    const baseY = 0
    const spanPx = Math.abs(fromX - toX)
    const arcHeight = Math.min(24, 10 + spanPx * 0.06)

    const d = `M ${fromX} ${baseY} C ${fromX} ${baseY + arcHeight}, ${toX} ${baseY + arcHeight}, ${toX} ${baseY}`

    paths.push({ d, endX: toX, endY: baseY })
  }

  return paths
}

export function StateRow({
  state,
  isActive,
  isPending,
  activeInstructionIndex,
  onStateClick,
  registerBadgeRef,
}: StateRowProps) {
  const nodeRefs = useRef<Map<number, HTMLElement | null>>(new Map())
  const rowRef = useRef<HTMLDivElement | null>(null)
  const [loopPaths, setLoopPaths] = useState<LoopPathData[]>([])

  const hasLoops = state.instructions.some((i) => i.loopTo !== null)

  useEffect(() => {
    if (!hasLoops) return

    const update = () => {
      if (!rowRef.current) return
      setLoopPaths(measureLoopPaths(state, rowRef.current, nodeRefs.current))
    }

    const raf = requestAnimationFrame(update)
    window.addEventListener("resize", update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", update)
    }
  }, [hasLoops, state])

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

      <div className="relative flex flex-col">
        <div ref={rowRef} className="flex items-start gap-1.5">
          {state.instructions.map((instr) => (
            <div
              key={instr.position}
              ref={(el) => {
                nodeRefs.current.set(instr.position, el)
              }}
            >
              <InstructionNode
                instruction={instr}
                isActive={isActive && activeInstructionIndex === instr.position}
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
              />
            </div>
          ))}
        </div>

        {loopPaths.length > 0 && (
          <svg
            aria-hidden="true"
            className="pointer-events-none w-full"
            style={{ height: 28, marginTop: -2 }}
          >
            {loopPaths.map((path, i) => (
              <path
                key={i}
                d={path.d}
                fill="none"
                stroke="currentColor"
                strokeDasharray="4 3"
                strokeLinecap="round"
                strokeWidth={1.5}
                className="text-muted-foreground/50"
              />
            ))}
            {loopPaths.map((path, i) => (
              <polygon
                key={`arrow-${i}`}
                points={`${path.endX},${path.endY} ${path.endX - 3},${path.endY + 6} ${path.endX + 3},${path.endY + 6}`}
                fill="currentColor"
                className="text-muted-foreground/50"
              />
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}
