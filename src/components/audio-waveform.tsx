import { Queue02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { AudioSection, formatMilliseconds } from "@/lib/audio";
import { cn } from "@/lib/utils";

export type TimelineViewMode = "compact-timeline" | "grid";

type AudioWaveformProps = {
  peaks: number[];
  durationSec: number;
  trimSec: number | null;
  sections: AudioSection[];
  viewMode: TimelineViewMode;
  activeSectionId: string | null;
  activeSectionProgress: number;
  pendingSectionId: string | null;
  onSectionSelect: (
    section: AudioSection,
    options?: { instant?: boolean }
  ) => void;
  disabled?: boolean;
  emptyMessage: string;
};

function getMaxSectionsPerRow(width: number | null) {
  if (width === null) {
    return 4;
  }

  if (width < 640) {
    return 1;
  }

  if (width < 960) {
    return 2;
  }

  if (width < 1440) {
    return 3;
  }

  return 4;
}

function chunkItems<T>(items: T[], chunkSize: number) {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

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
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [gridContainerWidth, setGridContainerWidth] = useState<number | null>(null);
  const normalizedDuration = durationSec > 0 ? durationSec : 1;
  const trimWidth =
    trimSec && trimSec > 0
      ? Math.min(100, (trimSec / normalizedDuration) * 100)
      : 0;
  const gridColumns = getMaxSectionsPerRow(gridContainerWidth);
  const sectionRows = chunkItems(sections, gridColumns);

  useEffect(() => {
    const element = gridContainerRef.current;

    if (!element) {
      return;
    }

    setGridContainerWidth(element.clientWidth);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setGridContainerWidth(entry?.contentRect.width ?? element.clientWidth);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

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
    colorClassName = "text-foreground/44",
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
              className="text-foreground/44"
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

  function renderSectionOverlay(
    section: AudioSection,
    {
      className,
      style,
      compact = false,
    }: {
      className?: string;
      style?: { left?: string; width?: string };
      compact?: boolean;
    } = {},
  ) {
    const isActive = section.id === activeSectionId;
    const isPending = section.id === pendingSectionId;
    const isQueueable = !disabled && !isActive && !isPending;
    const progress = isActive ? activeSectionProgress : 0;
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const progressWidth = `${clampedProgress * 100}%`;
    const progressMarkerLeft = `calc(${progressWidth} - 1px)`;

    function handleClick(event: MouseEvent<HTMLButtonElement>) {
      onSectionSelect(section, { instant: event.metaKey });
    }

    return (
      <button
        key={section.id}
        aria-pressed={isActive}
        data-waveform-section="true"
        className={cn(
          "group/section absolute overflow-hidden text-left outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/40",
          compact
            ? "inset-y-0 cursor-pointer border border-border/25 px-1.5 py-2"
            : "inset-0 cursor-pointer border border-border/25 px-2 py-1.5",
          className,
          isActive &&
            "z-10 bg-emerald-500/16 text-foreground ring-2 ring-inset ring-emerald-300/75",
          !isActive &&
            isPending &&
            "z-10 bg-amber-400/14 text-foreground ring-2 ring-inset ring-amber-300/80",
          !isActive &&
            !isPending &&
            "bg-background/5 hover:bg-background/10 focus-visible:bg-background/10",
          disabled && "cursor-default",
        )}
        disabled={disabled}
        onClick={handleClick}
        style={style}
        type="button"
      >
        {!isActive && !isPending ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/0 opacity-0 transition-opacity duration-150 group-hover/section:opacity-100 group-hover/section:bg-black/38 group-focus-visible/section:opacity-100 group-focus-visible/section:bg-black/38"
          />
        ) : null}

        {progress > 0 ? (
          <>
            <div
              aria-hidden="true"
              className="absolute inset-y-0 left-0 bg-emerald-400/28"
              style={{ width: progressWidth }}
            />
            <div
              aria-hidden="true"
              className="absolute inset-y-1 z-10 w-0.5 rounded-full bg-emerald-200 shadow-[0_0_12px_rgba(167,243,208,0.85)]"
              style={{ left: progressMarkerLeft }}
            />
          </>
        ) : null}

        {isPending ? (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-1 bg-amber-300/85"
          />
        ) : null}

        {isQueueable ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-10 flex items-center justify-center text-foreground opacity-0 transition-all duration-150 group-hover/section:opacity-100 group-focus-visible/section:opacity-100"
          >
            <div className="rounded-full bg-black/52 p-1.5 shadow-sm">
              <HugeiconsIcon icon={Queue02Icon} size={13} />
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            "relative z-10 flex h-full min-w-0 flex-col",
            compact ? "justify-center" : "justify-between"
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "truncate font-medium text-foreground",
                compact ? "text-[0.68rem]" : "text-[0.72rem]",
              )}
            >
              {section.label}
            </span>
          </div>

          {!compact ? (
            <div className="flex justify-end">
              <span className="truncate font-mono text-[0.62rem] text-foreground/85">
                {formatMilliseconds(section.startMs)}
              </span>
            </div>
          ) : null}
        </div>
      </button>
    );
  }

  function renderStandaloneSection(
    section: AudioSection,
    {
      className,
      style,
    }: {
      className?: string;
      style?: { flexBasis?: string; maxWidth?: string };
    } = {},
  ) {
    const sectionPeaks = getSectionPeaks(section);

    return (
      <div
        className={cn(
          "relative h-[64px] min-w-0 flex-1 overflow-hidden bg-background/60 sm:h-[58px] lg:h-[50px]",
          className
        )}
        key={section.id}
        style={style}
      >
        {renderWaveformLines(sectionPeaks, 0.8, "text-foreground/65")}
        {renderSectionOverlay(section)}
      </div>
    );
  }

  if (viewMode === "grid") {
    if (sections.length === 0) {
      return (
        <div className="flex min-h-32 items-center justify-center rounded-2xl border border-border/50 bg-muted/15 p-6 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-border/40">
        <div className="flex flex-col gap-px" ref={gridContainerRef}>
          {sectionRows.map((row, rowIndex) => {
            const sectionWidth =
              gridColumns === 1
                ? "100%"
                : `calc((100% - ${(gridColumns - 1).toString()}px) / ${gridColumns.toString()})`;

            return (
              <div
                className="flex gap-px justify-start"
                key={`row-${rowIndex}`}
              >
                {row.map((section) =>
                  renderStandaloneSection(section, {
                    className: "grow-0 shrink-0",
                    style: { flexBasis: sectionWidth, maxWidth: sectionWidth },
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-black/60">
      <div className="relative h-28 w-full">
        {renderWaveformLines(peaks, 0.65, "text-foreground/65")}

        {trimWidth > 0 ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 border-r border-border/50 bg-background/55"
            style={{ width: `${trimWidth}%` }}
          />
        ) : null}

        {sections.map((section) => {
          const left = (section.startSec / normalizedDuration) * 100;
          const width =
            ((section.endSec - section.startSec) / normalizedDuration) * 100;
          return renderSectionOverlay(section, {
            compact: true,
            style: { left: `${left}%`, width: `${width}%` },
          });
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
