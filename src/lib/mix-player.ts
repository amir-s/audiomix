import {
  CROSSFADE_DURATION_SEC,
  createAudioSections,
  type AudioSection,
} from "./audio.ts";
import { getRuntimeCrossfadeOverlayPlan } from "./crossfade-runtime.ts";
import {
  createNavigator,
  type CompiledMusicProgram,
  type Navigator,
  type NavigatorStatus,
} from "./music-dsl.ts";

const SCHEDULING_LEEWAY_SEC = 0.03;
const CROSSFADE_EDGE_EPSILON_SEC = 0.0001;
const DEFAULT_SOURCE_ID = "mixaudio-source";

type BrowserAudioGlobal = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  window?: Window &
    typeof globalThis & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
};

type PlaybackTarget = {
  timelineId: string;
  section: AudioSection;
  stateName: string | null;
  crossfadeDurationSec: number;
  fadeIn: boolean;
  fadeOut: boolean;
};

type ScheduledPlaybackItem = PlaybackTarget & {
  startTime: number;
};

type AudioOverlayHandle = {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  cleanup: () => void;
};

export type MixPlayerTransportState = "idle" | "playing" | "paused";

export type MixPlayerPlayOptions = {
  stateName?: string;
  instructionIndex?: number;
};

export type MixPlayerConfig = {
  crossfadeDurationMs?: number;
  audioContext?: AudioContext;
  autoResumeOnPlay?: boolean;
};

export type MixPlayerStatus = NavigatorStatus & {
  transportState: MixPlayerTransportState;
  isPaused: boolean;
  currentSectionProgress: number | null;
  currentSectionDurationSec: number | null;
  currentSectionStartedAtSec: number | null;
  currentFadeIn: boolean;
  currentFadeOut: boolean;
  nextFadeIn: boolean;
  nextFadeOut: boolean;
};

export type MixPlayerEvent =
  | { type: "status"; status: MixPlayerStatus }
  | { type: "error"; error: Error };

export type MixPlayerListener = (event: MixPlayerEvent) => void;

export type MixPlayer = {
  play(options?: MixPlayerPlayOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): void;
  goto(stateName: string): void;
  getStatus(): MixPlayerStatus;
  subscribe(listener: MixPlayerListener): () => void;
  destroy(): Promise<void>;
};

function getSectionLength(section: AudioSection) {
  return section.endSec - section.startSec;
}

function createSectionSource(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
) {
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.addEventListener("ended", () => {
    try {
      source.disconnect();
    } catch {}
  });

  return source;
}

function safeStopSource(source: AudioBufferSourceNode | null) {
  if (!source) {
    return;
  }

  try {
    source.stop();
  } catch {}

  try {
    source.disconnect();
  } catch {}
}

function createOverlayHandle(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  liveOverlays: Set<AudioOverlayHandle>,
) {
  const source = audioContext.createBufferSource();
  const gainNode = audioContext.createGain();
  let cleanedUp = false;

  source.buffer = audioBuffer;
  source.connect(gainNode);
  gainNode.connect(audioContext.destination);

  const handle = {
    source,
    gainNode,
    cleanup: () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      liveOverlays.delete(handle);

      try {
        source.disconnect();
      } catch {}

      try {
        gainNode.disconnect();
      } catch {}
    },
  } satisfies AudioOverlayHandle;

  liveOverlays.add(handle);
  source.addEventListener("ended", handle.cleanup, { once: true });

  return handle;
}

function safeStopOverlay(handle: AudioOverlayHandle | null) {
  if (!handle) {
    return;
  }

  try {
    handle.source.stop();
  } catch {}

  handle.cleanup();
}

function createIdleNavigatorStatus(): NavigatorStatus {
  return {
    currentStateName: null,
    currentSection: null,
    currentInstructionIndex: null,
    nextStateName: null,
    nextSection: null,
    nextInstructionIndex: null,
    pendingTargetStateName: null,
    nextComesFromPendingTransition: false,
  };
}

function normalizeCrossfadeDurationSec(config: MixPlayerConfig) {
  const durationMs = config.crossfadeDurationMs;

  if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) {
    return CROSSFADE_DURATION_SEC;
  }

  return durationMs / 1000;
}

function getAudioContextConstructor() {
  const audioGlobal = globalThis as BrowserAudioGlobal;

  return (
    audioGlobal.AudioContext ??
    audioGlobal.webkitAudioContext ??
    audioGlobal.window?.AudioContext ??
    audioGlobal.window?.webkitAudioContext ??
    null
  );
}

async function readSourceBytes(source: File | Blob | ArrayBuffer) {
  if (source instanceof ArrayBuffer) {
    return source.slice(0);
  }

  return source.arrayBuffer();
}

function createPlayerSections(
  compiled: CompiledMusicProgram,
  audioBuffer: AudioBuffer,
) {
  return createAudioSections({
    bpm: compiled.metadata.bpm,
    trimMs: compiled.metadata.trimMs ?? 0,
    durationSec: audioBuffer.duration,
    beatsPerSection: compiled.metadata.beatsPerSection ?? 16,
  });
}

export async function createMixPlayer(
  source: File | Blob | ArrayBuffer,
  config: MixPlayerConfig,
  compiled: CompiledMusicProgram,
): Promise<MixPlayer> {
  const ownedAudioContext = !config.audioContext;
  const AudioContextConstructor = ownedAudioContext
    ? getAudioContextConstructor()
    : null;

  if (ownedAudioContext && !AudioContextConstructor) {
    throw new Error("This environment does not support the Web Audio API.");
  }

  const audioContext =
    config.audioContext ?? new AudioContextConstructor!();
  const sourceBytes = await readSourceBytes(source);
  const audioBuffer = await audioContext.decodeAudioData(sourceBytes.slice(0));
  const sections = createPlayerSections(compiled, audioBuffer);

  if (sections.length !== compiled.metadata.sectionCount) {
    throw new Error(
      `Decoded audio produced ${sections.length.toString()} section(s), but the compiled mix expects ${compiled.metadata.sectionCount.toString()}.`,
    );
  }

  const listeners = new Set<MixPlayerListener>();
  const sourceId = compiled.metadata.sourceId ?? compiled.metadata.file ?? DEFAULT_SOURCE_ID;
  const crossfadeDurationSec = normalizeCrossfadeDurationSec(config);
  const autoResumeOnPlay = config.autoResumeOnPlay ?? true;
  const liveAudioOverlays = new Set<AudioOverlayHandle>();
  let destroyed = false;
  let transportState: MixPlayerTransportState = "idle";
  let navigator: Navigator | null = null;
  let navigatorStatus = createIdleNavigatorStatus();
  let currentSource: AudioBufferSourceNode | null = null;
  let scheduledSource: AudioBufferSourceNode | null = null;
  let currentPlayback: ScheduledPlaybackItem | null = null;
  let scheduledPlayback: ScheduledPlaybackItem | null = null;
  let currentFadeOutOverlay: AudioOverlayHandle | null = null;
  let queuedFadeInOverlay: AudioOverlayHandle | null = null;
  let playbackToken = 0;

  function emit(event: MixPlayerEvent) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function emitStatus() {
    emit({
      type: "status",
      status: getStatus(),
    });
  }

  function emitError(error: unknown) {
    emit({
      type: "error",
      error:
        error instanceof Error
          ? error
          : new Error("Mix player encountered an unknown runtime error."),
    });
  }

  function createPlaybackTarget(
    section: AudioSection,
    stateName: string | null,
    options?: { fadeIn?: boolean; fadeOut?: boolean },
  ) {
    return {
      timelineId: sourceId,
      section,
      stateName,
      crossfadeDurationSec,
      fadeIn: options?.fadeIn ?? false,
      fadeOut: options?.fadeOut ?? false,
    } satisfies PlaybackTarget;
  }

  function getTargetFromStatus(field: "current" | "next") {
    const sectionNumber =
      field === "current"
        ? navigatorStatus.currentSection
        : navigatorStatus.nextSection;
    const stateName =
      field === "current"
        ? navigatorStatus.currentStateName
        : navigatorStatus.nextStateName;
    const instructionIndex =
      field === "current"
        ? navigatorStatus.currentInstructionIndex
        : navigatorStatus.nextInstructionIndex;

    if (
      sectionNumber === null ||
      stateName === null ||
      instructionIndex === null
    ) {
      return null;
    }

    const section = sections[sectionNumber - 1] ?? null;
    const instruction =
      compiled.states[stateName]?.instructions[instructionIndex] ?? null;

    if (!section || !instruction || instruction.section !== sectionNumber) {
      return null;
    }

    return createPlaybackTarget(section, stateName, {
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    });
  }

  function clearQueuedFadeInOverlay() {
    safeStopOverlay(queuedFadeInOverlay);
    queuedFadeInOverlay = null;
  }

  function clearCurrentFadeOutOverlay() {
    safeStopOverlay(currentFadeOutOverlay);
    currentFadeOutOverlay = null;
  }

  function stopAllAudioOverlays() {
    clearQueuedFadeInOverlay();
    clearCurrentFadeOutOverlay();

    for (const overlay of Array.from(liveAudioOverlays)) {
      safeStopOverlay(overlay);
    }
  }

  function scheduleCurrentFadeOutOverlay(
    currentItem: ScheduledPlaybackItem,
    fadeOutEnabled = currentItem.fadeOut,
  ) {
    if (!fadeOutEnabled || currentItem.crossfadeDurationSec <= 0) {
      return;
    }

    if (
      currentItem.section.endSec + currentItem.crossfadeDurationSec >
      audioBuffer.duration + CROSSFADE_EDGE_EPSILON_SEC
    ) {
      return;
    }

    const boundaryTime =
      currentItem.startTime + getSectionLength(currentItem.section);
    const overlay = createOverlayHandle(
      audioContext,
      audioBuffer,
      liveAudioOverlays,
    );

    overlay.gainNode.gain.setValueAtTime(1, boundaryTime);
    overlay.gainNode.gain.linearRampToValueAtTime(
      0,
      boundaryTime + currentItem.crossfadeDurationSec,
    );
    overlay.source.start(
      boundaryTime,
      currentItem.section.endSec,
      currentItem.crossfadeDurationSec,
    );

    currentFadeOutOverlay = overlay;
  }

  function scheduleQueuedFadeInOverlay(
    queuedItem: ScheduledPlaybackItem,
    fadeInEnabled = queuedItem.fadeIn,
  ) {
    if (!fadeInEnabled || queuedItem.crossfadeDurationSec <= 0) {
      return;
    }

    if (
      queuedItem.section.startSec <
      queuedItem.crossfadeDurationSec - CROSSFADE_EDGE_EPSILON_SEC
    ) {
      return;
    }

    const fadeStartTime = queuedItem.startTime - queuedItem.crossfadeDurationSec;

    if (fadeStartTime <= audioContext.currentTime + SCHEDULING_LEEWAY_SEC) {
      return;
    }

    const overlay = createOverlayHandle(
      audioContext,
      audioBuffer,
      liveAudioOverlays,
    );

    overlay.gainNode.gain.setValueAtTime(0, fadeStartTime);
    overlay.gainNode.gain.linearRampToValueAtTime(1, queuedItem.startTime);
    overlay.source.start(
      fadeStartTime,
      queuedItem.section.startSec - queuedItem.crossfadeDurationSec,
      queuedItem.crossfadeDurationSec,
    );

    queuedFadeInOverlay = overlay;
  }

  function refreshCrossfadeOverlays(
    currentItem: ScheduledPlaybackItem | null,
    queuedItem: ScheduledPlaybackItem | null,
  ) {
    clearCurrentFadeOutOverlay();
    clearQueuedFadeInOverlay();

    if (!currentItem) {
      return;
    }

    const overlayPlan = getRuntimeCrossfadeOverlayPlan({
      current: currentItem,
      next: queuedItem,
      edgeEpsilonSec: CROSSFADE_EDGE_EPSILON_SEC,
    });

    scheduleCurrentFadeOutOverlay(currentItem, overlayPlan.currentFadeOut);

    if (!queuedItem) {
      return;
    }

    scheduleQueuedFadeInOverlay(queuedItem, overlayPlan.nextFadeIn);
  }

  function scheduleQueuedPlayback(
    currentItem: ScheduledPlaybackItem,
    nextTarget: PlaybackTarget | null,
  ) {
    const boundaryTime =
      currentItem.startTime + getSectionLength(currentItem.section);

    if (
      nextTarget &&
      boundaryTime <= audioContext.currentTime + SCHEDULING_LEEWAY_SEC
    ) {
      return false;
    }

    if (!nextTarget) {
      safeStopSource(scheduledSource);
      scheduledSource = null;
      scheduledPlayback = null;
      refreshCrossfadeOverlays(currentItem, null);
      return true;
    }

    const queuedItem: ScheduledPlaybackItem = {
      ...nextTarget,
      startTime: boundaryTime,
    };
    const queuedSource = createSectionSource(audioContext, audioBuffer);

    queuedSource.start(
      queuedItem.startTime,
      queuedItem.section.startSec,
      getSectionLength(queuedItem.section),
    );

    safeStopSource(scheduledSource);
    scheduledSource = queuedSource;
    scheduledPlayback = queuedItem;
    refreshCrossfadeOverlays(currentItem, queuedItem);

    return true;
  }

  function resetRuntimeState() {
    playbackToken += 1;
    stopAllAudioOverlays();
    safeStopSource(scheduledSource);
    safeStopSource(currentSource);
    currentSource = null;
    scheduledSource = null;
    currentPlayback = null;
    scheduledPlayback = null;
    currentFadeOutOverlay = null;
    queuedFadeInOverlay = null;
    navigator = null;
    navigatorStatus = createIdleNavigatorStatus();
    transportState = "idle";
  }

  function stopPlayback(emitStatusEvent = true) {
    resetRuntimeState();

    if (emitStatusEvent) {
      emitStatus();
    }
  }

  async function handleCurrentSectionEnded(token: number) {
    if (playbackToken !== token) {
      return;
    }

    const nextCurrentItem = scheduledPlayback;
    const nextCurrentSource = scheduledSource;

    currentSource = null;
    scheduledSource = null;
    currentPlayback = null;
    scheduledPlayback = null;
    currentFadeOutOverlay = null;
    queuedFadeInOverlay = null;

    if (!nextCurrentItem || !nextCurrentSource) {
      stopPlayback();
      return;
    }

    currentSource = nextCurrentSource;
    currentPlayback = nextCurrentItem;

    const nextToken = playbackToken + 1;
    playbackToken = nextToken;
    nextCurrentSource.addEventListener(
      "ended",
      () => {
        void handleCurrentSectionEnded(nextToken);
      },
      { once: true },
    );

    try {
      if (!navigator) {
        stopPlayback();
        return;
      }

      navigator.tick();
      navigatorStatus = navigator.getStatus();

      const followingTarget = getTargetFromStatus("next");
      const queued = scheduleQueuedPlayback(nextCurrentItem, followingTarget);

      if (!queued) {
        throw new Error("Unable to queue the next section in time.");
      }

      transportState =
        audioContext.state === "suspended" ? "paused" : "playing";
      emitStatus();
    } catch (error) {
      emitError(error);
      stopPlayback();
    }
  }

  function getStatus(): MixPlayerStatus {
    const currentDuration = currentPlayback
      ? getSectionLength(currentPlayback.section)
      : null;
    const currentStartedAt = currentPlayback?.startTime ?? null;
    const currentSectionProgress =
      currentPlayback && currentDuration && currentDuration > 0
        ? Math.max(
            0,
            Math.min(
              1,
              (audioContext.currentTime - currentPlayback.startTime) /
                currentDuration,
            ),
          )
        : null;

    return {
      ...navigatorStatus,
      transportState,
      isPaused: transportState === "paused",
      currentSectionProgress,
      currentSectionDurationSec: currentDuration,
      currentSectionStartedAtSec: currentStartedAt,
      currentFadeIn: currentPlayback?.fadeIn ?? false,
      currentFadeOut: currentPlayback?.fadeOut ?? false,
      nextFadeIn: scheduledPlayback?.fadeIn ?? false,
      nextFadeOut: scheduledPlayback?.fadeOut ?? false,
    };
  }

  return {
    async play(options = {}) {
      if (destroyed) {
        throw new Error("This mix player has already been destroyed.");
      }

      if (autoResumeOnPlay && audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const stateName = options.stateName ?? compiled.stateOrder[0] ?? null;

      if (!stateName) {
        throw new Error("The compiled mix does not contain any playable states.");
      }

      const nextNavigator = createNavigator(compiled);
      nextNavigator.start(stateName, options.instructionIndex ?? 0);
      navigator = nextNavigator;
      navigatorStatus = nextNavigator.getStatus();

      const currentTarget = getTargetFromStatus("current");

      if (!currentTarget) {
        throw new Error(`State '${stateName}' does not point to a playable section.`);
      }

      const nextTarget = getTargetFromStatus("next");
      const startTime = audioContext.currentTime + 0.01;
      const nextCurrentItem: ScheduledPlaybackItem = {
        ...currentTarget,
        startTime,
      };
      const nextToken = playbackToken + 1;
      playbackToken = nextToken;

      stopAllAudioOverlays();
      safeStopSource(scheduledSource);
      safeStopSource(currentSource);

      currentSource = null;
      scheduledSource = null;
      currentPlayback = null;
      scheduledPlayback = null;

      const nextSource = createSectionSource(audioContext, audioBuffer);

      nextSource.start(
        nextCurrentItem.startTime,
        currentTarget.section.startSec,
        getSectionLength(currentTarget.section),
      );
      nextSource.addEventListener(
        "ended",
        () => {
          void handleCurrentSectionEnded(nextToken);
        },
        { once: true },
      );

      currentSource = nextSource;
      currentPlayback = nextCurrentItem;
      transportState =
        audioContext.state === "suspended" ? "paused" : "playing";

      const queued = scheduleQueuedPlayback(nextCurrentItem, nextTarget);

      if (!queued) {
        stopPlayback(false);
        throw new Error("Unable to queue the next section in time.");
      }

      emitStatus();
    },

    async pause() {
      if (destroyed || transportState === "idle") {
        return;
      }

      if (audioContext.state === "running") {
        await audioContext.suspend();
      }

      transportState = "paused";
      emitStatus();
    },

    async resume() {
      if (destroyed || transportState === "idle") {
        return;
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      transportState = currentPlayback ? "playing" : "idle";
      emitStatus();
    },

    stop() {
      if (destroyed) {
        return;
      }

      stopPlayback();
    },

    goto(stateName: string) {
      if (destroyed) {
        throw new Error("This mix player has already been destroyed.");
      }

      if (!navigator || !currentPlayback || transportState === "idle") {
        throw new Error("Cannot queue a state transition before playback starts.");
      }

      try {
        navigator.goTo(stateName);
        navigatorStatus = navigator.getStatus();
        const nextTarget = getTargetFromStatus("next");
        const queued = scheduleQueuedPlayback(currentPlayback, nextTarget);

        if (!queued) {
          throw new Error("Unable to queue the next state in time.");
        }

        emitStatus();
      } catch (error) {
        emitError(error);
        throw error;
      }
    },

    getStatus,

    subscribe(listener: MixPlayerListener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    async destroy() {
      if (destroyed) {
        return;
      }

      stopPlayback();
      destroyed = true;
      listeners.clear();

      if (ownedAudioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }
    },
  };
}
