import { cn } from "@/lib/utils";
import { AudioSection, formatMilliseconds } from "@/lib/audio";

export type TimelineViewMode = "compact-timeline" | "timeline" | "grid";

type AudioWaveformProps = {
  peaks: number[];
  durationSec: number;
  trimSec: number | null;
  sections: AudioSection[];
  viewMode: TimelineViewMode;
  activeSectionId: string | null;
  activeSectionProgress: number;
  pendingSectionId: string | null;
  onSectionSelect: (section: AudioSection) => void;
  disabled?: boolean;
  emptyMessage: string;
};

export function AudioWaveform({
  peaks,
  durationSec,
  trimSec,
  sections,
  viewMode,
  activeSectionId,
  activeSectionProgress,
  pendingSectionId,
  onSectionSelect,
  disabled = false,
  emptyMessage,
}: AudioWaveformProps) {
  const normalizedDuration = durationSec > 0 ? durationSec : 1;
  const trimWidth =
    trimSec && trimSec > 0
      ? Math.min(100, (trimSec / normalizedDuration) * 100)
      : 0;

  function getSectionPeaks(section: AudioSection) {
    if (peaks.length === 0) {
      return [];
    }

    const startIndex = Math.max(
      0,
      Math.floor((section.startSec / normalizedDuration) * peaks.length),
    );
    const endIndex = Math.max(
      startIndex + 1,
      Math.min(
        peaks.length,
        Math.ceil((section.endSec / normalizedDuration) * peaks.length),
      ),
    );

    return peaks.slice(startIndex, endIndex);
  }

  function renderWaveformLines(
    sectionPeaks: number[],
    strokeWidth: number,
    colorClassName = "text-foreground/70",
  ) {
    if (sectionPeaks.length === 0) {
      return null;
    }

    return (
      <svg
        aria-hidden="true"
        className={cn("absolute inset-0 size-full", colorClassName)}
        preserveAspectRatio="none"
        viewBox={`0 0 ${sectionPeaks.length} 100`}
      >
        {sectionPeaks.map((peak, index) => {
          const height = Math.max(4, peak * 92);
          const y1 = 50 - height / 2;
          const y2 = 50 + height / 2;

          return (
            <line
              key={`peak-${index}`}
              className="text-foreground/70"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth={strokeWidth}
              x1={index + 0.5}
              x2={index + 0.5}
              y1={y1}
              y2={y2}
            />
          );
        })}
      </svg>
    );
  }

  function renderStripSection(
    section: AudioSection,
    {
      className,
      heightClassName,
    }: {
      className?: string;
      heightClassName?: string;
    } = {},
  ) {
    const sectionPeaks = getSectionPeaks(section);
    const isActive = section.id === activeSectionId;
    const isPending = section.id === pendingSectionId;
    const progress = isActive ? activeSectionProgress : 0;
    const progressWidth = `${Math.max(0, Math.min(1, progress)) * 100}%`;

    return (
      <button
        key={section.id}
        aria-pressed={isActive}
        className={cn(
          "relative overflow-hidden bg-muted/20 text-left outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/40",
          heightClassName ?? "h-14",
          className,
          isActive &&
            "z-10 bg-emerald-950/10 text-foreground ring-2 ring-inset ring-emerald-900/90",
          !isActive &&
            isPending &&
            "z-10 bg-red-950/10 text-foreground ring-2 ring-inset ring-red-900/90",
          !isActive && !isPending && "hover:bg-accent/50",
        )}
        disabled={disabled}
        onClick={() => onSectionSelect(section)}
        type="button"
      >
        {progress > 0 ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 bg-emerald-950/14"
            style={{ width: progressWidth }}
          />
        ) : null}

        {renderWaveformLines(sectionPeaks, 0.85, "text-foreground/45")}

        <div className="relative z-10 flex h-full min-w-0 flex-col justify-between p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[0.65rem] font-semibold tracking-[0.18em] uppercase">
              {section.label}
            </span>
            <span className="truncate font-mono text-[0.62rem] text-muted-foreground">
              {formatMilliseconds(section.startMs)}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[0.62rem] text-muted-foreground">
              {formatMilliseconds(section.startMs)}
            </span>
            <span className="truncate font-mono text-[0.62rem] text-muted-foreground">
              {formatMilliseconds(section.endMs)}
            </span>
          </div>
        </div>
      </button>
    );
  }

  if (viewMode === "timeline" || viewMode === "grid") {
    if (sections.length === 0) {
      return (
        <div className="flex min-h-32 items-center justify-center rounded-xl border border-border/70 bg-muted/20 p-6 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        </div>
      );
    }

    return viewMode === "timeline" ? (
      <div className="overflow-x-auto pb-2">
        <div className="min-w-max overflow-hidden rounded-lg border border-border/70 bg-border/70">
          <div className="flex gap-px">
            {sections.map((section) =>
              renderStripSection(section, {
                className: "w-[230px] shrink-0",
              }),
            )}
          </div>
        </div>
      </div>
    ) : (
      <div className="overflow-x-auto pb-2">
        <div className="min-w-max overflow-hidden rounded-lg border border-border/70 bg-border/70">
          <div className="grid auto-rows-[56px] gap-px [grid-template-columns:repeat(4,230px)]">
            {sections.map((section) => renderStripSection(section))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/70 bg-muted/20">
      <div className="relative h-25 w-full">
        {renderWaveformLines(peaks, 0.65)}

        {trimWidth > 0 ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 border-r border-border bg-background/70"
            style={{ width: `${trimWidth}%` }}
          />
        ) : null}

        {sections.map((section) => {
          const left = (section.startSec / normalizedDuration) * 100;
          const width =
            ((section.endSec - section.startSec) / normalizedDuration) * 100;
          const isActive = section.id === activeSectionId;
          const isPending = section.id === pendingSectionId;
          const progress = isActive ? activeSectionProgress : 0;
          const progressWidth = `${Math.max(0, Math.min(1, progress)) * 100}%`;

          return (
            <button
              key={section.id}
              aria-pressed={isActive}
              className={cn(
                "absolute inset-y-0 overflow-hidden border-r border-border/80 px-2 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                isActive &&
                  "z-10 bg-emerald-950/12 text-foreground ring-2 ring-inset ring-emerald-900/90",
                !isActive &&
                  isPending &&
                  "z-10 bg-red-950/12 text-foreground ring-2 ring-inset ring-red-900/90",
                !isActive &&
                  !isPending &&
                  "bg-background/10 hover:bg-accent/50",
              )}
              disabled={disabled}
              onClick={() => onSectionSelect(section)}
              style={{ left: `${left}%`, width: `${width}%` }}
              type="button"
            >
              {progress > 0 ? (
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-emerald-950/16"
                  style={{ width: progressWidth }}
                />
              ) : null}

              <span className="relative z-10 flex h-full min-w-0 flex-col justify-between">
                <span className="truncate text-[0.7rem] font-semibold tracking-[0.18em] uppercase">
                  {section.label}
                </span>
                <span className="truncate font-mono text-[0.65rem] text-muted-foreground">
                  {formatMilliseconds(section.startMs)} to{" "}
                  {formatMilliseconds(section.endMs)}
                </span>
              </span>
            </button>
          );
        })}

        {sections.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
