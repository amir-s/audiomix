import type { AudioSection } from "./audio.ts";

export type RuntimeCrossfadePlaybackItem = {
  timelineId: string;
  section: Pick<AudioSection, "startSec" | "endSec">;
  fadeIn: boolean;
  fadeOut: boolean;
};

export type RuntimeCrossfadeOverlayPlan = {
  currentFadeOut: boolean;
  nextFadeIn: boolean;
  suppressesAdjacentBoundary: boolean;
};

export function getRuntimeCrossfadeOverlayPlan({
  current,
  next,
  edgeEpsilonSec = 0.0001,
}: {
  current: RuntimeCrossfadePlaybackItem;
  next: RuntimeCrossfadePlaybackItem | null;
  edgeEpsilonSec?: number;
}): RuntimeCrossfadeOverlayPlan {
  const suppressesAdjacentBoundary =
    next !== null &&
    current.timelineId === next.timelineId &&
    Math.abs(current.section.endSec - next.section.startSec) <= edgeEpsilonSec;

  return {
    currentFadeOut: current.fadeOut && !suppressesAdjacentBoundary,
    nextFadeIn: (next?.fadeIn ?? false) && !suppressesAdjacentBoundary,
    suppressesAdjacentBoundary,
  };
}
