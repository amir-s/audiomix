import { useRef, useState, useEffect } from "react"

import {
  type CompiledMusicProgram,
  type MusicDslInstructionIdentity,
} from "@/lib/music-dsl"

import { StateRow } from "./music-dsl-visualizer/state-row"
import { useNodePositions } from "./music-dsl-visualizer/use-node-positions"
import { WireOverlay } from "./music-dsl-visualizer/wire-overlay"

type MusicDslVisualizerProps = {
  program: CompiledMusicProgram
  activeStateName: string | null
  activeInstructionIndex: number | null
  pendingStateName: string | null
  selectedInstruction?: MusicDslInstructionIdentity | null
  onInstructionClick?: (
    instruction: MusicDslInstructionIdentity,
    options?: { connect?: boolean; force?: boolean }
  ) => void
  onStateClick?: (stateName: string, options?: { force?: boolean }) => void
}

export function MusicDslVisualizer({
  program,
  activeStateName,
  activeInstructionIndex,
  pendingStateName,
  selectedInstruction,
  onInstructionClick,
  onStateClick,
}: MusicDslVisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { wires, registerBadgeRef, measure } = useNodePositions(containerRef, program)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const update = () => {
      setContainerSize({ width: el.scrollWidth, height: el.scrollHeight })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Re-measure wires when active state changes (playback cursor moves)
  useEffect(() => {
    measure()
  }, [activeStateName, activeInstructionIndex, measure])

  return (
    <div ref={containerRef} className="relative overflow-x-auto">
      <div className="flex flex-col gap-1 py-2">
        {program.stateOrder.map((stateName) => {
          const state = program.states[stateName]
          if (!state) return null

          return (
            <StateRow
              key={stateName}
              state={state}
              isActive={activeStateName === stateName}
              isPending={pendingStateName === stateName}
              activeInstructionIndex={
                activeStateName === stateName ? activeInstructionIndex : null
              }
              selectedInstruction={selectedInstruction}
              onInstructionClick={onInstructionClick}
              onStateClick={onStateClick}
              registerBadgeRef={registerBadgeRef}
            />
          )
        })}
      </div>
      <WireOverlay
        wires={wires}
        width={containerSize.width}
        height={containerSize.height}
      />
    </div>
  )
}
