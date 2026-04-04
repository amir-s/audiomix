const LABEL_COLORS = [
  "#60a5fa",
  "#f97316",
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#facc15",
  "#2dd4bf",
  "#c084fc",
]

export function getLabelColor(label: string): string {
  let hash = 0
  for (const ch of label) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length]
}
