import { useCallback, useEffect, useRef, useState, type RefCallback, type RefObject } from "react"

import { type CompiledMusicProgram } from "@/lib/music-dsl"

import { getLabelColor } from "./label-colors"

export type WireConnection = {
  fromX: number
  fromY: number
  toX: number
  toY: number
  label: string
  color: string
}

export function useNodePositions(
  containerRef: RefObject<HTMLDivElement | null>,
  program: CompiledMusicProgram
) {
  const badgeElements = useRef<Map<string, HTMLElement>>(new Map())
  const [wires, setWires] = useState<WireConnection[]>([])

  const registerBadgeRef = useCallback(
    (key: string): RefCallback<HTMLElement> => {
      return (el: HTMLElement | null) => {
        if (el) {
          badgeElements.current.set(key, el)
        } else {
          badgeElements.current.delete(key)
        }
      }
    },
    []
  )

  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      setWires([])
      return
    }

    const containerRect = container.getBoundingClientRect()
    const connections: WireConnection[] = []

    for (const stateName of program.stateOrder) {
      const state = program.states[stateName]
      if (!state) continue

      for (const instr of state.instructions) {
        if (!instr.exitLabel) continue

        const exitKey = `${stateName}:${instr.position}:exit`
        const exitEl = badgeElements.current.get(exitKey)
        if (!exitEl) continue

        // Find all matching entry points across all states
        for (const targetStateName of program.stateOrder) {
          const targetState = program.states[targetStateName]
          if (!targetState) continue

          const entryIndex = targetState.entryPoints[instr.exitLabel]
          if (entryIndex === undefined) continue

          const entryKey = `${targetStateName}:${entryIndex}:entry`
          const entryEl = badgeElements.current.get(entryKey)
          if (!entryEl) continue

          const exitRect = exitEl.getBoundingClientRect()
          const entryRect = entryEl.getBoundingClientRect()

          connections.push({
            fromX: exitRect.left + exitRect.width / 2 - containerRect.left,
            fromY: exitRect.top + exitRect.height - containerRect.top,
            toX: entryRect.left + entryRect.width / 2 - containerRect.left,
            toY: entryRect.top - containerRect.top,
            label: instr.exitLabel,
            color: getLabelColor(instr.exitLabel),
          })
        }
      }
    }

    setWires(connections)
  }, [containerRef, program])

  useEffect(() => {
    // Measure after a frame to let layout settle
    const raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [measure])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      measure()
    })
    observer.observe(container)

    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [containerRef, measure])

  return { wires, registerBadgeRef, measure }
}
