import { type WireConnection } from "./use-node-positions"

type WireOverlayProps = {
  wires: WireConnection[]
  width: number
  height: number
}

export function WireOverlay({ wires, width, height }: WireOverlayProps) {
  if (wires.length === 0 || width === 0 || height === 0) return null

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ width, height }}
    >
      {wires.map((wire, i) => {
        const midY = (wire.fromY + wire.toY) / 2
        const d = `M ${wire.fromX} ${wire.fromY} C ${wire.fromX} ${midY}, ${wire.toX} ${midY}, ${wire.toX} ${wire.toY}`

        return (
          <path
            key={`${wire.label}-${i}`}
            d={d}
            fill="none"
            stroke={wire.color}
            strokeLinecap="round"
            strokeOpacity={0.45}
            strokeWidth={2}
            className="transition-[stroke-opacity] hover:pointer-events-auto hover:stroke-[3px] hover:[stroke-opacity:0.8]"
          />
        )
      })}
    </svg>
  )
}
