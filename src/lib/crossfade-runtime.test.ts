import assert from "node:assert/strict";
import test from "node:test";

import { getRuntimeCrossfadeOverlayPlan } from "./crossfade-runtime.ts";

function createPlaybackItem({
  timelineId = "timeline-a",
  startSec,
  endSec,
  fadeIn = false,
  fadeOut = false,
}: {
  timelineId?: string;
  startSec: number;
  endSec: number;
  fadeIn?: boolean;
  fadeOut?: boolean;
}) {
  return {
    timelineId,
    section: { startSec, endSec },
    fadeIn,
    fadeOut,
  };
}

test("adjacent same-timeline transitions suppress the queued fade-in", () => {
  const plan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56 }),
    next: createPlaybackItem({ startSec: 56, endSec: 64, fadeIn: true }),
  });

  assert.deepEqual(plan, {
    currentFadeOut: false,
    nextFadeIn: false,
    suppressesAdjacentBoundary: true,
  });
});

test("adjacent same-timeline transitions suppress the current fade-out", () => {
  const plan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56, fadeOut: true }),
    next: createPlaybackItem({ startSec: 56, endSec: 64 }),
  });

  assert.deepEqual(plan, {
    currentFadeOut: false,
    nextFadeIn: false,
    suppressesAdjacentBoundary: true,
  });
});

test("adjacent same-timeline transitions suppress both runtime fades", () => {
  const plan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56, fadeOut: true }),
    next: createPlaybackItem({ startSec: 56, endSec: 64, fadeIn: true }),
  });

  assert.deepEqual(plan, {
    currentFadeOut: false,
    nextFadeIn: false,
    suppressesAdjacentBoundary: true,
  });
});

test("non-adjacent jumps preserve fade overlays", () => {
  const fadeOutPlan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56, fadeOut: true }),
    next: createPlaybackItem({ startSec: 72, endSec: 80 }),
  });
  const fadeInPlan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 24, endSec: 32 }),
    next: createPlaybackItem({ startSec: 56, endSec: 64, fadeIn: true }),
  });

  assert.deepEqual(fadeOutPlan, {
    currentFadeOut: true,
    nextFadeIn: false,
    suppressesAdjacentBoundary: false,
  });
  assert.deepEqual(fadeInPlan, {
    currentFadeOut: false,
    nextFadeIn: true,
    suppressesAdjacentBoundary: false,
  });
});

test("self-repeats still preserve fade overlays", () => {
  const fadeOutPlan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56, fadeOut: true }),
    next: createPlaybackItem({ startSec: 48, endSec: 56 }),
  });
  const fadeInPlan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56 }),
    next: createPlaybackItem({ startSec: 48, endSec: 56, fadeIn: true }),
  });

  assert.deepEqual(fadeOutPlan, {
    currentFadeOut: true,
    nextFadeIn: false,
    suppressesAdjacentBoundary: false,
  });
  assert.deepEqual(fadeInPlan, {
    currentFadeOut: false,
    nextFadeIn: true,
    suppressesAdjacentBoundary: false,
  });
});

test("different timelines never count as adjacent", () => {
  const plan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({
      timelineId: "timeline-a",
      startSec: 48,
      endSec: 56,
      fadeOut: true,
    }),
    next: createPlaybackItem({
      timelineId: "timeline-b",
      startSec: 56,
      endSec: 64,
      fadeIn: true,
    }),
  });

  assert.deepEqual(plan, {
    currentFadeOut: true,
    nextFadeIn: true,
    suppressesAdjacentBoundary: false,
  });
});

test("no queued target preserves the current fade-out into silence", () => {
  const plan = getRuntimeCrossfadeOverlayPlan({
    current: createPlaybackItem({ startSec: 48, endSec: 56, fadeOut: true }),
    next: null,
  });

  assert.deepEqual(plan, {
    currentFadeOut: true,
    nextFadeIn: false,
    suppressesAdjacentBoundary: false,
  });
});
