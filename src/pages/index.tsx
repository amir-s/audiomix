import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import Head from "next/head"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Delete01Icon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  Settings01Icon,
  ViewAgendaIcon,
} from "@hugeicons/core-free-icons"

import { AudioWaveform, TimelineViewMode } from "@/components/audio-waveform"
import { MusicDslEditor } from "@/components/music-dsl-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AudioSection,
  CROSSFADE_DURATION_SEC,
  createAudioSections,
  extractWaveformPeaks,
  formatDuration,
  formatMilliseconds,
  getSectionDurationSec,
} from "@/lib/audio"
import {
  compileMusicDsl,
  createNavigator,
  type CompiledMusicProgram,
  type MusicDslDiagnostic,
  type Navigator,
  type NavigatorStatus,
} from "@/lib/music-dsl"
import {
  deleteTimelineFile,
  loadPersistedAppState,
  loadTimelineFile,
  type PersistedTimelineMetadata,
  savePersistedAppState,
  saveTimelineFile,
} from "@/lib/timeline-storage"
import { cn } from "@/lib/utils"

type BrowserAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

type PlaybackMode = "idle" | "manual" | "code"

type TimelineState = PersistedTimelineMetadata & {
  audioBuffer: AudioBuffer | null
  waveformPeaks: number[]
  isDecoding: boolean
  errorMessage: string | null
  compiledProgram: CompiledMusicProgram | null
  lastCompiledDslInput: string | null
  lastCompiledSectionCount: number | null
  lastRunDiagnostics: MusicDslDiagnostic[]
  selectedCodeState: string | null
  lastActiveCodeState: string | null
}

type TimelineSelection = {
  timelineId: string
  sectionId: string
}

type FadeControls = {
  fadeIn: boolean
  fadeOut: boolean
}

type PlaybackTarget = {
  timelineId: string
  section: AudioSection
  stateName: string | null
  crossfadeDurationSec: number
  fadeIn: boolean
  fadeOut: boolean
}

type ScheduledPlaybackItem = PlaybackTarget & {
  startTime: number
}

type AudioOverlayHandle = {
  source: AudioBufferSourceNode
  gainNode: GainNode
  cleanup: () => void
}

type HydrateTimelineFromBlob = (
  metadata: PersistedTimelineMetadata,
  blob: Blob,
  options: { persistFile: boolean }
) => Promise<void>

type PreparedTimeline = TimelineState & {
  bpmValue: number
  bpmIsValid: boolean
  loopDurationSec: number | null
  crossfadeDurationValueMs: number
  crossfadeDurationIsValid: boolean
  crossfadeDurationSec: number
  trimValue: number
  trimIsValid: boolean
  trimWithinDuration: boolean
  trimHasValidRange: boolean
  durationSec: number
  sections: AudioSection[]
  message: string
  codeIsDirty: boolean
}

function getTimelineSummary(timeline: PreparedTimeline) {
  if (timeline.isDecoding) {
    return "Building waveform..."
  }

  if (timeline.audioBuffer) {
    return `${formatDuration(timeline.audioBuffer.duration)} · ${
      timeline.sections.length
    } section${timeline.sections.length === 1 ? "" : "s"}`
  }

  return "Waiting for audio"
}

function createTimelineId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `timeline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  )
}

function createSelectionKey(selection: TimelineSelection | null) {
  if (!selection) {
    return null
  }

  return `${selection.timelineId}:${selection.sectionId}`
}

function getDefaultFadeControls(): FadeControls {
  return {
    fadeIn: false,
    fadeOut: false,
  }
}

function isTimelineViewMode(value: string): value is TimelineViewMode {
  return value === "compact-timeline" || value === "grid"
}

function getAcceptedAudioFiles(files: File[]) {
  return files.filter((file) => !file.type || file.type.startsWith("audio/"))
}

function createTimelinePlaceholder(
  metadata: PersistedTimelineMetadata
): TimelineState {
  return {
    ...metadata,
    audioBuffer: null,
    waveformPeaks: [],
    isDecoding: true,
    errorMessage: null,
    compiledProgram: null,
    lastCompiledDslInput: null,
    lastCompiledSectionCount: null,
    lastRunDiagnostics: [],
    selectedCodeState: null,
    lastActiveCodeState: null,
  }
}

function getTimelineWaveformMessage({
  timeline,
  bpmIsValid,
  trimIsValid,
  trimWithinDuration,
  sections,
}: {
  timeline: TimelineState
  bpmIsValid: boolean
  trimIsValid: boolean
  trimWithinDuration: boolean
  sections: AudioSection[]
}) {
  if (timeline.isDecoding) {
    return "Decoding audio and calculating waveform peaks..."
  }

  if (timeline.errorMessage && !timeline.audioBuffer) {
    return timeline.errorMessage
  }

  if (!timeline.audioBuffer) {
    return "This timeline is waiting for its audio data."
  }

  if (!bpmIsValid) {
    return "Enter a positive BPM value to split this track into 16-beat sections."
  }

  if (!trimIsValid) {
    return "Enter a start time in milliseconds starting from 0."
  }

  if (!trimWithinDuration) {
    return "Set the start time inside the file duration to generate sections."
  }

  if (sections.length === 0) {
    return "No full 16-beat sections fit after the selected start time."
  }

  return "Click a section to play it manually. In code mode, the current and queued sections follow the DSL."
}

const SCHEDULING_LEEWAY_SEC = 0.03
const CROSSFADE_EDGE_EPSILON_SEC = 0.0001
const DEFAULT_CROSSFADE_DURATION_INPUT = String(
  Math.round(CROSSFADE_DURATION_SEC * 1000)
)

function createSectionSource(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer
) {
  const source = audioContext.createBufferSource()
  source.buffer = audioBuffer
  source.connect(audioContext.destination)
  source.addEventListener("ended", () => {
    try {
      source.disconnect()
    } catch {}
  })

  return source
}

function safeStopSource(source: AudioBufferSourceNode | null) {
  if (!source) {
    return
  }

  try {
    source.stop()
  } catch {}

  try {
    source.disconnect()
  } catch {}
}

function createOverlayHandle(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  liveOverlays: Set<AudioOverlayHandle>
) {
  const source = audioContext.createBufferSource()
  const gainNode = audioContext.createGain()
  let cleanedUp = false

  source.buffer = audioBuffer
  source.connect(gainNode)
  gainNode.connect(audioContext.destination)

  const handle = {
    source,
    gainNode,
    cleanup: () => {
      if (cleanedUp) {
        return
      }

      cleanedUp = true
      liveOverlays.delete(handle)

      try {
        source.disconnect()
      } catch {}

      try {
        gainNode.disconnect()
      } catch {}
    },
  } satisfies AudioOverlayHandle

  liveOverlays.add(handle)
  source.addEventListener("ended", handle.cleanup, { once: true })

  return handle
}

function safeStopOverlay(handle: AudioOverlayHandle | null) {
  if (!handle) {
    return
  }

  try {
    handle.source.stop()
  } catch {}

  handle.cleanup()
}

function getSectionLength(section: AudioSection) {
  return section.endSec - section.startSec
}

function getTargetSelection(
  target: PlaybackTarget | ScheduledPlaybackItem
): TimelineSelection {
  return {
    timelineId: target.timelineId,
    sectionId: target.section.id,
  }
}

function getStateOptions(timeline: PreparedTimeline) {
  return timeline.compiledProgram?.stateOrder ?? []
}

function getDslDebugOutput(timeline: PreparedTimeline) {
  return JSON.stringify(
    {
      codeIsDirty: timeline.codeIsDirty,
      selectedCodeState: timeline.selectedCodeState,
      lastActiveCodeState: timeline.lastActiveCodeState,
      lastCompiledDslInput: timeline.lastCompiledDslInput,
      lastCompiledSectionCount: timeline.lastCompiledSectionCount,
      diagnostics: timeline.lastRunDiagnostics,
      compiledProgram: timeline.compiledProgram,
    },
    null,
    2
  )
}

export default function Home() {
  const audioContextRef = useRef<AudioContext | null>(null)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const scheduledSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const currentPlaybackRef = useRef<ScheduledPlaybackItem | null>(null)
  const scheduledPlaybackRef = useRef<ScheduledPlaybackItem | null>(null)
  const liveAudioOverlaysRef = useRef(new Set<AudioOverlayHandle>())
  const currentFadeOutOverlayRef = useRef<AudioOverlayHandle | null>(null)
  const queuedFadeInOverlayRef = useRef<AudioOverlayHandle | null>(null)
  const dragDepthRef = useRef(0)
  const addFilesRef = useRef<(files: File[]) => Promise<void>>(async () => undefined)
  const hydrateTimelineFromBlobRef =
    useRef<HydrateTimelineFromBlob>(async () => undefined)
  const timelineTaskTokensRef = useRef(new Map<string, number>())
  const taskCounterRef = useRef(0)
  const persistenceReadyRef = useRef(false)
  const stopPlaybackRef = useRef<(clearActive?: boolean) => void>(() => undefined)
  const playbackTokenRef = useRef(0)
  const playbackModeRef = useRef<PlaybackMode>("idle")
  const codeNavigatorRef = useRef<Navigator | null>(null)
  const codeRuntimeStatusRef = useRef<NavigatorStatus | null>(null)
  const preparedTimelinesRef = useRef<PreparedTimeline[]>([])
  const manualDeferredTargetRef = useRef<PlaybackTarget | null>(null)

  const [timelines, setTimelines] = useState<TimelineState[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [selectedTimelineId, setSelectedTimelineId] = useState<string | null>(null)
  const [timelineViewMode, setTimelineViewMode] =
    useState<TimelineViewMode>("compact-timeline")
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false)
  const [activeSectionProgress, setActiveSectionProgress] = useState(0)
  const [activeSelection, setActiveSelection] = useState<TimelineSelection | null>(
    null
  )
  const [pendingSelection, setPendingSelection] =
    useState<TimelineSelection | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>("idle")
  const [codeRuntimeStatus, setCodeRuntimeStatus] =
    useState<NavigatorStatus | null>(null)

  const preparedTimelines: PreparedTimeline[] = timelines.map((timeline) => {
    const bpmValue = Number.parseFloat(timeline.bpmInput)
    const bpmIsValid = Number.isFinite(bpmValue) && bpmValue > 0
    const loopDurationSec = bpmIsValid ? getSectionDurationSec(bpmValue) : null
    const crossfadeDurationValueMs = Number.parseFloat(
      timeline.crossfadeDurationInput
    )
    const crossfadeDurationIsValid =
      Number.isFinite(crossfadeDurationValueMs) && crossfadeDurationValueMs >= 0
    const crossfadeDurationSec = crossfadeDurationIsValid
      ? crossfadeDurationValueMs / 1000
      : 0
    const trimValue = Number.parseFloat(timeline.trimInput)
    const trimIsValid = Number.isFinite(trimValue) && trimValue >= 0
    const durationSec = timeline.audioBuffer?.duration ?? 0
    const trimWithinDuration =
      trimIsValid && durationSec > 0 && trimValue / 1000 < durationSec
    const trimHasValidRange =
      trimIsValid && (!timeline.audioBuffer || trimWithinDuration)
    const sections =
      timeline.audioBuffer && bpmIsValid && trimIsValid
        ? createAudioSections({
            bpm: bpmValue,
            trimMs: trimValue,
            durationSec: timeline.audioBuffer.duration,
          })
        : []
    const codeIsDirty =
      timeline.lastCompiledDslInput !== timeline.dslInput ||
      timeline.lastCompiledSectionCount !== sections.length

    return {
      ...timeline,
      bpmValue,
      bpmIsValid,
      loopDurationSec,
      crossfadeDurationValueMs,
      crossfadeDurationIsValid,
      crossfadeDurationSec,
      trimValue,
      trimIsValid,
      trimWithinDuration,
      trimHasValidRange,
      durationSec,
      sections,
      message: getTimelineWaveformMessage({
        timeline,
        bpmIsValid,
        trimIsValid,
        trimWithinDuration,
        sections,
      }),
      codeIsDirty,
    }
  })

  preparedTimelinesRef.current = preparedTimelines

  const selectedTimeline =
    preparedTimelines.find((timeline) => timeline.id === selectedTimelineId) ??
    preparedTimelines[0] ??
    null
  const selectedTimelineDslDebugOutput = selectedTimeline
    ? getDslDebugOutput(selectedTimeline)
    : ""

  const activeSelectionKey = createSelectionKey(activeSelection)
  const pendingSelectionKey = createSelectionKey(pendingSelection)

  function updateTimeline(
    timelineId: string,
    updater: (timeline: TimelineState) => TimelineState
  ) {
    setTimelines((currentTimelines) =>
      currentTimelines.map((timeline) =>
        timeline.id === timelineId ? updater(timeline) : timeline
      )
    )
  }

  function updateActiveSelection(selection: TimelineSelection | null) {
    setActiveSelection(selection)
  }

  function updatePendingSelection(selection: TimelineSelection | null) {
    setPendingSelection(selection)
  }

  function setPlaybackModeValue(nextMode: PlaybackMode) {
    playbackModeRef.current = nextMode
    setPlaybackMode(nextMode)
  }

  function setCodeRuntimeStatusValue(nextStatus: NavigatorStatus | null) {
    codeRuntimeStatusRef.current = nextStatus
    setCodeRuntimeStatus(nextStatus)
  }

  function getPreparedTimelineById(timelineId: string) {
    return (
      preparedTimelinesRef.current.find((timeline) => timeline.id === timelineId) ??
      null
    )
  }

  function createTaskToken(timelineId: string) {
    const nextToken = taskCounterRef.current + 1
    taskCounterRef.current = nextToken
    timelineTaskTokensRef.current.set(timelineId, nextToken)
    return nextToken
  }

  function isTaskCurrent(timelineId: string, token: number) {
    return timelineTaskTokensRef.current.get(timelineId) === token
  }

  function createPlaybackTarget(
    timeline: PreparedTimeline,
    section: AudioSection,
    stateName: string | null,
    options?: { fadeIn?: boolean; fadeOut?: boolean }
  ) {
    return {
      timelineId: timeline.id,
      section,
      stateName,
      crossfadeDurationSec: timeline.crossfadeDurationSec,
      fadeIn: options?.fadeIn ?? false,
      fadeOut: options?.fadeOut ?? false,
    } satisfies PlaybackTarget
  }

  function getManualFadeControls(timeline: PreparedTimeline | TimelineState) {
    return {
      fadeIn: timeline.manualFadeInEnabled,
      fadeOut: timeline.manualFadeOutEnabled,
    } satisfies FadeControls
  }

  function createManualPlaybackTarget(
    timeline: PreparedTimeline,
    section: AudioSection
  ) {
    return createPlaybackTarget(timeline, section, null, getManualFadeControls(timeline))
  }

  function getCodePlaybackFadeControls(timelineId: string) {
    return {
      fadeIn:
        (scheduledPlaybackRef.current?.timelineId === timelineId &&
          scheduledPlaybackRef.current.fadeIn) ||
        (manualDeferredTargetRef.current?.timelineId === timelineId &&
          manualDeferredTargetRef.current.fadeIn) ||
        false,
      fadeOut:
        (currentPlaybackRef.current?.timelineId === timelineId &&
          currentPlaybackRef.current.fadeOut) ||
        false,
    } satisfies FadeControls
  }

  function getCodeTargetFromStatus(
    timeline: PreparedTimeline,
    program: CompiledMusicProgram | null,
    status: NavigatorStatus,
    field: "current" | "next"
  ) {
    const sectionNumber =
      field === "current" ? status.currentSection : status.nextSection
    const stateName =
      field === "current" ? status.currentStateName : status.nextStateName
    const instructionIndex =
      field === "current"
        ? status.currentInstructionIndex
        : status.nextInstructionIndex

    if (
      sectionNumber === null ||
      stateName === null ||
      instructionIndex === null ||
      !program
    ) {
      return null
    }

    const section = timeline.sections[sectionNumber - 1] ?? null
    const instruction = program.states[stateName]?.instructions[instructionIndex] ?? null

    if (!section || !instruction || instruction.section !== sectionNumber) {
      return null
    }

    return createPlaybackTarget(timeline, section, stateName, {
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })
  }

  function clearQueuedFadeInOverlay() {
    safeStopOverlay(queuedFadeInOverlayRef.current)
    queuedFadeInOverlayRef.current = null
  }

  function stopAllAudioOverlays() {
    clearQueuedFadeInOverlay()
    currentFadeOutOverlayRef.current = null

    for (const overlay of Array.from(liveAudioOverlaysRef.current)) {
      safeStopOverlay(overlay)
    }
  }

  function scheduleCurrentFadeOutOverlay(
    audioContext: AudioContext,
    currentItem: ScheduledPlaybackItem
  ) {
    safeStopOverlay(currentFadeOutOverlayRef.current)
    currentFadeOutOverlayRef.current = null
    const crossfadeDurationSec = currentItem.crossfadeDurationSec

    if (!currentItem.fadeOut || crossfadeDurationSec <= 0) {
      return
    }

    const timeline = getPreparedTimelineById(currentItem.timelineId)

    if (!timeline?.audioBuffer) {
      return
    }

    if (
      currentItem.section.endSec + crossfadeDurationSec >
      timeline.audioBuffer.duration + CROSSFADE_EDGE_EPSILON_SEC
    ) {
      return
    }

    const boundaryTime = currentItem.startTime + getSectionLength(currentItem.section)
    const overlay = createOverlayHandle(
      audioContext,
      timeline.audioBuffer,
      liveAudioOverlaysRef.current
    )

    overlay.gainNode.gain.setValueAtTime(1, boundaryTime)
    overlay.gainNode.gain.linearRampToValueAtTime(
      0,
      boundaryTime + crossfadeDurationSec
    )
    overlay.source.start(
      boundaryTime,
      currentItem.section.endSec,
      crossfadeDurationSec
    )

    currentFadeOutOverlayRef.current = overlay
  }

  function scheduleQueuedFadeInOverlay(
    audioContext: AudioContext,
    queuedItem: ScheduledPlaybackItem,
    audioBuffer: AudioBuffer
  ) {
    clearQueuedFadeInOverlay()
    const crossfadeDurationSec = queuedItem.crossfadeDurationSec

    if (!queuedItem.fadeIn || crossfadeDurationSec <= 0) {
      return
    }

    if (
      queuedItem.section.startSec <
      crossfadeDurationSec - CROSSFADE_EDGE_EPSILON_SEC
    ) {
      return
    }

    const fadeStartTime = queuedItem.startTime - crossfadeDurationSec

    if (fadeStartTime <= audioContext.currentTime + SCHEDULING_LEEWAY_SEC) {
      return
    }

    const overlay = createOverlayHandle(
      audioContext,
      audioBuffer,
      liveAudioOverlaysRef.current
    )

    overlay.gainNode.gain.setValueAtTime(0, fadeStartTime)
    overlay.gainNode.gain.linearRampToValueAtTime(1, queuedItem.startTime)
    overlay.source.start(
      fadeStartTime,
      queuedItem.section.startSec - crossfadeDurationSec,
      crossfadeDurationSec
    )

    queuedFadeInOverlayRef.current = overlay
  }

  async function ensureAudioContext({ resume = true }: { resume?: boolean } = {}) {
    if (audioContextRef.current) {
      if (resume && audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume()
      }

      return audioContextRef.current
    }

    const browserWindow = window as BrowserAudioWindow
    const AudioContextConstructor =
      browserWindow.AudioContext ?? browserWindow.webkitAudioContext

    if (!AudioContextConstructor) {
      throw new Error("This browser does not support the Web Audio API.")
    }

    const audioContext = new AudioContextConstructor()

    if (resume && audioContext.state === "suspended") {
      await audioContext.resume()
    }

    audioContextRef.current = audioContext

    return audioContext
  }

  async function decodeTimelineBlob(blob: Blob) {
    const audioContext = await ensureAudioContext({ resume: false })
    const fileBytes = await blob.arrayBuffer()
    const decodedBuffer = await audioContext.decodeAudioData(fileBytes.slice(0))
    const peaks = extractWaveformPeaks(decodedBuffer)

    return { decodedBuffer, peaks }
  }

  async function hydrateTimelineFromBlob(
    metadata: PersistedTimelineMetadata,
    blob: Blob,
    { persistFile }: { persistFile: boolean }
  ) {
    const taskToken = createTaskToken(metadata.id)

    try {
      const { decodedBuffer, peaks } = await decodeTimelineBlob(blob)

      if (!isTaskCurrent(metadata.id, taskToken)) {
        return
      }

      let timelineError: string | null = null

      if (persistFile) {
        try {
          await saveTimelineFile(metadata.id, blob)

          if (!isTaskCurrent(metadata.id, taskToken)) {
            await deleteTimelineFile(metadata.id)
            return
          }
        } catch (error) {
          timelineError =
            error instanceof Error
              ? `${error.message} Refreshes may not restore this file.`
              : "Unable to persist this file for refreshes."
        }
      }

      startTransition(() => {
        updateTimeline(metadata.id, (timeline) => ({
          ...timeline,
          audioBuffer: decodedBuffer,
          waveformPeaks: peaks,
          isDecoding: false,
          errorMessage: timelineError,
        }))
      })
    } catch (error) {
      if (!isTaskCurrent(metadata.id, taskToken)) {
        return
      }

      updateTimeline(metadata.id, (timeline) => ({
        ...timeline,
        audioBuffer: null,
        waveformPeaks: [],
        isDecoding: false,
        errorMessage:
          error instanceof Error
            ? error.message
            : "The browser could not decode that audio file.",
      }))
    } finally {
      if (isTaskCurrent(metadata.id, taskToken)) {
        timelineTaskTokensRef.current.delete(metadata.id)
      }
    }
  }

  async function addFiles(files: File[]) {
    const acceptedFiles = getAcceptedAudioFiles(files)
    const ignoredFileCount = files.length - acceptedFiles.length

    if (acceptedFiles.length === 0) {
      setErrorMessage("Choose audio files so the browser can decode them.")
      return
    }

    setErrorMessage(
      ignoredFileCount > 0
        ? `${ignoredFileCount} dropped file${
            ignoredFileCount === 1 ? " was" : "s were"
          } ignored because it was not audio.`
        : null
    )

    const timelineEntries = acceptedFiles.map((file) => {
      const metadata: PersistedTimelineMetadata = {
        id: createTimelineId(),
        fileName: file.name,
        fileType: file.type,
        fileLastModified: file.lastModified,
        bpmInput: "",
        crossfadeDurationInput: DEFAULT_CROSSFADE_DURATION_INPUT,
        manualFadeInEnabled: false,
        manualFadeOutEnabled: false,
        trimInput: "0",
        dslInput: "",
      }

      return {
        file,
        metadata,
        placeholder: createTimelinePlaceholder(metadata),
      }
    })

    setTimelines((currentTimelines) => [
      ...currentTimelines,
      ...timelineEntries.map((entry) => entry.placeholder),
    ])

    for (const entry of timelineEntries) {
      await hydrateTimelineFromBlob(entry.metadata, entry.file, { persistFile: true })
    }
  }

  addFilesRef.current = addFiles
  hydrateTimelineFromBlobRef.current = hydrateTimelineFromBlob

  async function scheduleQueuedPlayback(
    currentItem: ScheduledPlaybackItem,
    nextTarget: PlaybackTarget | null
  ) {
    const audioContext = await ensureAudioContext()
    const boundaryTime = currentItem.startTime + getSectionLength(currentItem.section)

    if (nextTarget && boundaryTime <= audioContext.currentTime + SCHEDULING_LEEWAY_SEC) {
      return false
    }

    if (!nextTarget) {
      clearQueuedFadeInOverlay()
      safeStopSource(scheduledSourceRef.current)
      scheduledSourceRef.current = null
      scheduledPlaybackRef.current = null
      updatePendingSelection(null)
      return true
    }

    const nextTimeline = getPreparedTimelineById(nextTarget.timelineId)

    if (!nextTimeline?.audioBuffer) {
      throw new Error("The queued track is missing its decoded audio buffer.")
    }

    const queuedItem: ScheduledPlaybackItem = {
      ...nextTarget,
      startTime: boundaryTime,
    }
    const queuedSource = createSectionSource(
      audioContext,
      nextTimeline.audioBuffer
    )

    queuedSource.start(
      queuedItem.startTime,
      nextTarget.section.startSec,
      getSectionLength(nextTarget.section)
    )

    clearQueuedFadeInOverlay()
    safeStopSource(scheduledSourceRef.current)
    scheduledSourceRef.current = queuedSource
    scheduledPlaybackRef.current = queuedItem
    scheduleQueuedFadeInOverlay(audioContext, queuedItem, nextTimeline.audioBuffer)
    updatePendingSelection(getTargetSelection(queuedItem))

    return true
  }

  async function handleCurrentSectionEnded(token: number) {
    if (playbackTokenRef.current !== token) {
      return
    }

    const nextCurrentItem = scheduledPlaybackRef.current
    const nextCurrentSource = scheduledSourceRef.current

    currentSourceRef.current = null
    scheduledSourceRef.current = null
    currentPlaybackRef.current = null
    scheduledPlaybackRef.current = null
    currentFadeOutOverlayRef.current = null
    queuedFadeInOverlayRef.current = null

    if (!nextCurrentItem || !nextCurrentSource) {
      currentSourceRef.current = null
      currentPlaybackRef.current = null
      manualDeferredTargetRef.current = null
      codeNavigatorRef.current = null
      updatePendingSelection(null)
      updateActiveSelection(null)
      setActiveSectionProgress(0)
      setPlaybackModeValue("idle")
      setCodeRuntimeStatusValue(null)
      return
    }

    currentSourceRef.current = nextCurrentSource
    currentPlaybackRef.current = nextCurrentItem
    scheduleCurrentFadeOutOverlay(audioContextRef.current!, nextCurrentItem)
    updateActiveSelection(getTargetSelection(nextCurrentItem))
    setActiveSectionProgress(0)

    const nextToken = playbackTokenRef.current + 1
    playbackTokenRef.current = nextToken
    nextCurrentSource.addEventListener(
      "ended",
      () => {
        void handleCurrentSectionEnded(nextToken)
      },
      { once: true }
    )

    let followingTarget: PlaybackTarget | null = null

    if (playbackModeRef.current === "manual") {
      const deferredTarget = manualDeferredTargetRef.current
      manualDeferredTargetRef.current = null
      followingTarget =
        deferredTarget ??
        ({
          timelineId: nextCurrentItem.timelineId,
          section: nextCurrentItem.section,
          stateName: null,
          crossfadeDurationSec: nextCurrentItem.crossfadeDurationSec,
          fadeIn: false,
          fadeOut: false,
        } satisfies PlaybackTarget)
      setCodeRuntimeStatusValue(null)
    } else if (playbackModeRef.current === "code") {
      const navigator = codeNavigatorRef.current
      const timeline = getPreparedTimelineById(nextCurrentItem.timelineId)

      if (!navigator || !timeline) {
        stopPlaybackRef.current()
        return
      }

      navigator.tick()
      const status = navigator.getStatus()
      setCodeRuntimeStatusValue(status)

      if (status.currentStateName) {
        updateTimeline(nextCurrentItem.timelineId, (timelineState) => ({
          ...timelineState,
          lastActiveCodeState: status.currentStateName,
        }))
      }

      followingTarget = getCodeTargetFromStatus(
        timeline,
        timeline.compiledProgram,
        status,
        "next"
      )
    }

    try {
      const queued = await scheduleQueuedPlayback(nextCurrentItem, followingTarget)

      if (!queued && playbackModeRef.current === "manual" && followingTarget) {
        manualDeferredTargetRef.current = followingTarget
        updatePendingSelection(getTargetSelection(nextCurrentItem))
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to queue the next section."
      )
      stopPlaybackRef.current()
    }
  }

  async function beginPlaybackSequence({
    timeline,
    currentTarget,
    nextTarget,
    mode,
    navigator,
    status,
  }: {
    timeline: PreparedTimeline
    currentTarget: PlaybackTarget
    nextTarget: PlaybackTarget | null
    mode: PlaybackMode
    navigator: Navigator | null
    status: NavigatorStatus | null
  }) {
    if (!timeline.audioBuffer) {
      return
    }

    const audioContext = await ensureAudioContext()
    const startTime = audioContext.currentTime + 0.01
    const nextCurrentItem: ScheduledPlaybackItem = {
      ...currentTarget,
      startTime,
    }
    const nextToken = playbackTokenRef.current + 1
    playbackTokenRef.current = nextToken

    stopAllAudioOverlays()
    safeStopSource(scheduledSourceRef.current)
    safeStopSource(currentSourceRef.current)

    currentSourceRef.current = null
    scheduledSourceRef.current = null
    currentPlaybackRef.current = null
    scheduledPlaybackRef.current = null
    manualDeferredTargetRef.current = null

    const currentSource = createSectionSource(
      audioContext,
      timeline.audioBuffer
    )

    currentSource.start(
      nextCurrentItem.startTime,
      currentTarget.section.startSec,
      getSectionLength(currentTarget.section)
    )

    currentSource.addEventListener(
      "ended",
      () => {
        void handleCurrentSectionEnded(nextToken)
      },
      { once: true }
    )

    currentSourceRef.current = currentSource
    currentPlaybackRef.current = nextCurrentItem
    scheduleCurrentFadeOutOverlay(audioContext, nextCurrentItem)
    codeNavigatorRef.current = mode === "code" ? navigator : null
    setPlaybackModeValue(mode)
    setCodeRuntimeStatusValue(mode === "code" ? status : null)
    setSelectedTimelineId(timeline.id)
    updateActiveSelection(getTargetSelection(nextCurrentItem))
    updatePendingSelection(null)
    setActiveSectionProgress(0)
    setIsPlaybackPaused(false)
    setErrorMessage(null)

    const queued = await scheduleQueuedPlayback(nextCurrentItem, nextTarget)

    if (!queued && mode === "manual" && nextTarget) {
      manualDeferredTargetRef.current = nextTarget
      updatePendingSelection(getTargetSelection(nextCurrentItem))
    }
  }

  stopPlaybackRef.current = (clearActive = true) => {
    playbackTokenRef.current += 1
    stopAllAudioOverlays()
    safeStopSource(scheduledSourceRef.current)
    safeStopSource(currentSourceRef.current)
    currentSourceRef.current = null
    scheduledSourceRef.current = null
    currentPlaybackRef.current = null
    scheduledPlaybackRef.current = null
    currentFadeOutOverlayRef.current = null
    queuedFadeInOverlayRef.current = null
    codeNavigatorRef.current = null
    manualDeferredTargetRef.current = null
    updatePendingSelection(null)
    setPlaybackModeValue("idle")
    setCodeRuntimeStatusValue(null)
    setIsPlaybackPaused(false)
    setActiveSectionProgress(0)

    if (clearActive) {
      updateActiveSelection(null)
    }
  }

  async function startManualPlayback(
    timeline: PreparedTimeline,
    section: AudioSection
  ) {
    const target = createManualPlaybackTarget(timeline, section)

    await beginPlaybackSequence({
      timeline,
      currentTarget: target,
      nextTarget: target,
      mode: "manual",
      navigator: null,
      status: null,
    })
  }

  async function queueManualPlayback(
    timeline: PreparedTimeline,
    section: AudioSection
  ) {
    const currentItem = currentPlaybackRef.current

    if (!currentItem) {
      await startManualPlayback(timeline, section)
      return
    }

    const target = createManualPlaybackTarget(timeline, section)
    const queued = await scheduleQueuedPlayback(currentItem, target)

    if (!queued) {
      manualDeferredTargetRef.current = target
      updatePendingSelection(getTargetSelection(currentItem))
    }
  }

  async function startCodePlayback(
    timeline: PreparedTimeline,
    program: CompiledMusicProgram,
    stateName: string
  ) {
    const navigator = createNavigator(program)
    navigator.start(stateName)
    const status = navigator.getStatus()
    const currentTarget = getCodeTargetFromStatus(
      timeline,
      program,
      status,
      "current"
    )

    if (!currentTarget) {
      throw new Error(`State '${stateName}' does not point to a playable section.`)
    }

    const nextTarget = getCodeTargetFromStatus(timeline, program, status, "next")

    updateTimeline(timeline.id, (timelineState) => ({
      ...timelineState,
      lastActiveCodeState: status.currentStateName,
    }))

    await beginPlaybackSequence({
      timeline,
      currentTarget,
      nextTarget,
      mode: "code",
      navigator,
      status,
    })
  }

  async function togglePlaybackPause() {
    const audioContext = audioContextRef.current

    if (!audioContext || !activeSelection) {
      return
    }

    try {
      if (audioContext.state === "running") {
        await audioContext.suspend()
        setIsPlaybackPaused(true)
      } else if (audioContext.state === "suspended") {
        await audioContext.resume()
        setIsPlaybackPaused(false)
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to change playback state."
      )
    }
  }

  const handleSpacebarToggle = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return
    }

    const target = event.target
    const isWaveformSectionTarget =
      target instanceof HTMLElement &&
      target.closest("[data-waveform-section='true']") !== null
    const isButtonTarget =
      target instanceof HTMLElement && target.closest("button") !== null

    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    ) {
      return
    }

    if (isWaveformSectionTarget || isButtonTarget) {
      event.preventDefault()
    }

    if (!activeSelection) {
      return
    }

    event.preventDefault()
    void togglePlaybackPause()
  })

  async function handleSectionSelect(
    timeline: PreparedTimeline,
    section: AudioSection,
    options?: { instant?: boolean }
  ) {
    const nextSelectionKey = createSelectionKey({
      timelineId: timeline.id,
      sectionId: section.id,
    })

    if (playbackModeRef.current === "code") {
      codeNavigatorRef.current = null
      setCodeRuntimeStatusValue(null)
      setPlaybackModeValue("manual")
    }

    if (options?.instant) {
      await startManualPlayback(timeline, section)
      return
    }

    if (nextSelectionKey === pendingSelectionKey) {
      return
    }

    if (nextSelectionKey === activeSelectionKey) {
      await startManualPlayback(timeline, section)
      return
    }

    if (!activeSelection || !currentPlaybackRef.current) {
      await startManualPlayback(timeline, section)
      return
    }

    try {
      await queueManualPlayback(timeline, section)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to queue the next section."
      )
    }
  }

  async function handleRunCode(timeline: PreparedTimeline) {
    const compileResult = compileMusicDsl(timeline.dslInput, {
      file: timeline.fileName,
      bpm: timeline.bpmIsValid ? timeline.bpmValue : 0,
      beatsPerSection: 16,
      sectionCount: timeline.sections.length,
    })
    const compiledProgram = compileResult.program
    const selectedCodeState =
      compiledProgram && timeline.selectedCodeState
        ? compiledProgram.states[timeline.selectedCodeState]
          ? timeline.selectedCodeState
          : null
        : null
    const fallbackSelectedState =
      selectedCodeState ?? compiledProgram?.stateOrder[0] ?? null
    const activeCodeState =
      playbackModeRef.current === "code" &&
      activeSelection?.timelineId === timeline.id &&
      codeRuntimeStatusRef.current?.currentStateName &&
      compiledProgram?.states[codeRuntimeStatusRef.current.currentStateName]
        ? codeRuntimeStatusRef.current.currentStateName
        : null

    updateTimeline(timeline.id, (timelineState) => ({
      ...timelineState,
      compiledProgram: compiledProgram ?? timelineState.compiledProgram,
      lastCompiledDslInput: compiledProgram
        ? timeline.dslInput
        : timelineState.lastCompiledDslInput,
      lastCompiledSectionCount: compiledProgram
        ? timeline.sections.length
        : timelineState.lastCompiledSectionCount,
      lastRunDiagnostics: compileResult.diagnostics,
      selectedCodeState: fallbackSelectedState,
    }))

    if (!compiledProgram) {
      if (
        playbackModeRef.current === "code" &&
        activeSelection?.timelineId === timeline.id
      ) {
        stopPlaybackRef.current()
      }
      return
    }

    const startState =
      activeCodeState ?? fallbackSelectedState ?? compiledProgram.stateOrder[0] ?? null

    if (!startState) {
      setErrorMessage("The DSL did not produce any playable states.")
      return
    }

    try {
      await startCodePlayback(timeline, compiledProgram, startState)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start code playback."
      )
    }
  }

  async function handlePlayCodeState(
    timeline: PreparedTimeline,
    stateName: string
  ) {
    if (!timeline.compiledProgram || timeline.codeIsDirty) {
      return
    }

    updateTimeline(timeline.id, (timelineState) => ({
      ...timelineState,
      selectedCodeState: stateName,
    }))

    try {
      await startCodePlayback(timeline, timeline.compiledProgram, stateName)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start the selected state."
      )
    }
  }

  async function handleGoToState(
    timeline: PreparedTimeline,
    stateName: string
  ) {
    if (
      !timeline.compiledProgram ||
      timeline.codeIsDirty ||
      playbackModeRef.current !== "code" ||
      activeSelection?.timelineId !== timeline.id
    ) {
      return
    }

    const navigator = codeNavigatorRef.current

    if (!navigator) {
      return
    }

    updateTimeline(timeline.id, (timelineState) => ({
      ...timelineState,
      selectedCodeState: stateName,
    }))

    try {
      navigator.goTo(stateName)
      const status = navigator.getStatus()
      setCodeRuntimeStatusValue(status)
      const currentItem = currentPlaybackRef.current

      if (!currentItem) {
        return
      }

      const nextTarget = getCodeTargetFromStatus(
        timeline,
        timeline.compiledProgram,
        status,
        "next"
      )
      const queued = await scheduleQueuedPlayback(currentItem, nextTarget)

      if (!queued) {
        updatePendingSelection(
          scheduledPlaybackRef.current
            ? getTargetSelection(scheduledPlaybackRef.current)
            : null
        )
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to queue the next state."
      )
    }
  }

  async function handleCodeStateButtonPress(
    timeline: PreparedTimeline,
    stateName: string,
    options?: { force?: boolean }
  ) {
    updateTimeline(timeline.id, (timelineState) => ({
      ...timelineState,
      selectedCodeState: stateName,
    }))

    if (options?.force) {
      await handlePlayCodeState(timeline, stateName)
      return
    }

    await handleGoToState(timeline, stateName)
  }

  function handleSelectedTimelineChange(nextTimelineId: string) {
    if (nextTimelineId === selectedTimelineId) {
      return
    }

    if (
      (activeSelection !== null && activeSelection.timelineId !== nextTimelineId) ||
      (pendingSelection !== null && pendingSelection.timelineId !== nextTimelineId)
    ) {
      stopPlaybackRef.current()
    }

    setSelectedTimelineId(nextTimelineId)
  }

  function handleTimelineBpmInputChange(timelineId: string, bpmInput: string) {
    setTimelines((currentTimelines) =>
      currentTimelines.map((timeline) =>
        timeline.id === timelineId ? { ...timeline, bpmInput } : timeline
      )
    )

    if (
      activeSelection?.timelineId === timelineId ||
      pendingSelection?.timelineId === timelineId
    ) {
      stopPlaybackRef.current()
    }
  }

  function handleCrossfadeDurationInputChange(
    timelineId: string,
    crossfadeDurationInput: string
  ) {
    setTimelines((currentTimelines) =>
      currentTimelines.map((timeline) =>
        timeline.id === timelineId
          ? { ...timeline, crossfadeDurationInput }
          : timeline
      )
    )

    if (
      activeSelection?.timelineId === timelineId ||
      pendingSelection?.timelineId === timelineId
    ) {
      stopPlaybackRef.current()
    }
  }

  function handleTimelineFadeToggle(
    timeline: PreparedTimeline,
    field: keyof FadeControls
  ) {
    const currentFadeControls = getManualFadeControls(timeline)
    const nextFadeControls = {
      ...currentFadeControls,
      [field]: !currentFadeControls[field],
    } satisfies FadeControls

    setTimelines((currentTimelines) =>
      currentTimelines.map((timelineState) =>
        timelineState.id === timeline.id
          ? {
              ...timelineState,
              manualFadeInEnabled: nextFadeControls.fadeIn,
              manualFadeOutEnabled: nextFadeControls.fadeOut,
            }
          : timelineState
      )
    )

    if (playbackModeRef.current !== "manual") {
      return
    }

    const audioContext = audioContextRef.current

    if (currentPlaybackRef.current?.timelineId === timeline.id) {
      currentPlaybackRef.current = {
        ...currentPlaybackRef.current,
        ...nextFadeControls,
      }

      if (audioContext) {
        scheduleCurrentFadeOutOverlay(audioContext, currentPlaybackRef.current)
      }
    }

    if (scheduledPlaybackRef.current?.timelineId === timeline.id) {
      scheduledPlaybackRef.current = {
        ...scheduledPlaybackRef.current,
        ...nextFadeControls,
      }

      const preparedTimeline = getPreparedTimelineById(timeline.id)

      if (audioContext && preparedTimeline?.audioBuffer) {
        scheduleQueuedFadeInOverlay(
          audioContext,
          scheduledPlaybackRef.current,
          preparedTimeline.audioBuffer
        )
      }
    }

    if (manualDeferredTargetRef.current?.timelineId === timeline.id) {
      manualDeferredTargetRef.current = {
        ...manualDeferredTargetRef.current,
        ...nextFadeControls,
      }
    }
  }

  function handleTrimInputChange(timelineId: string, trimInput: string) {
    setTimelines((currentTimelines) =>
      currentTimelines.map((timeline) =>
        timeline.id === timelineId ? { ...timeline, trimInput } : timeline
      )
    )

    if (
      activeSelection?.timelineId === timelineId ||
      pendingSelection?.timelineId === timelineId
    ) {
      stopPlaybackRef.current()
    }
  }

  function handleDslInputChange(timelineId: string, dslInput: string) {
    setTimelines((currentTimelines) =>
      currentTimelines.map((timeline) =>
        timeline.id === timelineId ? { ...timeline, dslInput } : timeline
      )
    )
  }

  async function handleTimelineRemove(timelineId: string) {
    const timelineIndex = timelines.findIndex((timeline) => timeline.id === timelineId)
    const fallbackTimeline =
      timelines[timelineIndex + 1] ?? timelines[timelineIndex - 1] ?? null

    timelineTaskTokensRef.current.delete(timelineId)

    setTimelines((currentTimelines) =>
      currentTimelines.filter((timeline) => timeline.id !== timelineId)
    )
    setSelectedTimelineId((currentSelectedTimelineId) =>
      currentSelectedTimelineId === timelineId
        ? (fallbackTimeline?.id ?? null)
        : currentSelectedTimelineId
    )

    if (
      activeSelection?.timelineId === timelineId ||
      pendingSelection?.timelineId === timelineId
    ) {
      stopPlaybackRef.current()
    }

    try {
      await deleteTimelineFile(timelineId)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to remove the stored file."
      )
    }
  }

  useEffect(() => {
    if (preparedTimelines.length === 0) {
      if (selectedTimelineId !== null) {
        setSelectedTimelineId(null)
      }
      return
    }

    const hasSelectedTimeline = preparedTimelines.some(
      (timeline) => timeline.id === selectedTimelineId
    )

    if (!hasSelectedTimeline) {
      setSelectedTimelineId(preparedTimelines[0].id)
    }
  }, [preparedTimelines, selectedTimelineId])

  useEffect(() => {
    function hasFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files")
    }

    function handleWindowDragEnter(event: DragEvent) {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current += 1
      setIsDragging(true)
    }

    function handleWindowDragOver(event: DragEvent) {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()

      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy"
      }

      setIsDragging(true)
    }

    function handleWindowDragLeave(event: DragEvent) {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

      if (dragDepthRef.current === 0) {
        setIsDragging(false)
      }
    }

    function handleWindowDrop(event: DragEvent) {
      if (!hasFiles(event)) {
        return
      }

      event.preventDefault()
      dragDepthRef.current = 0
      setIsDragging(false)

      const droppedFiles = Array.from(event.dataTransfer?.files ?? [])

      if (droppedFiles.length === 0) {
        return
      }

      void addFilesRef.current(droppedFiles)
    }

    window.addEventListener("dragenter", handleWindowDragEnter)
    window.addEventListener("dragover", handleWindowDragOver)
    window.addEventListener("dragleave", handleWindowDragLeave)
    window.addEventListener("drop", handleWindowDrop)

    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter)
      window.removeEventListener("dragover", handleWindowDragOver)
      window.removeEventListener("dragleave", handleWindowDragLeave)
      window.removeEventListener("drop", handleWindowDrop)
    }
  }, [])

  useEffect(() => {
    if (!activeSelection) {
      setActiveSectionProgress(0)
      return
    }

    let frameId = 0

    const updateProgress = () => {
      const audioContext = audioContextRef.current
      const currentItem = currentPlaybackRef.current

      if (!audioContext || !currentItem) {
        setActiveSectionProgress(0)
        return
      }

      const duration = getSectionLength(currentItem.section)

      if (duration <= 0) {
        setActiveSectionProgress(0)
        return
      }

      const elapsed = Math.max(0, audioContext.currentTime - currentItem.startTime)
      const progress = Math.max(0, Math.min(1, elapsed / duration))

      setActiveSectionProgress(progress)

      if (!isPlaybackPaused) {
        frameId = window.requestAnimationFrame(updateProgress)
      }
    }

    updateProgress()

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [activeSelection, isPlaybackPaused])

  useEffect(() => {
    let cancelled = false
    const timelineTaskTokens = timelineTaskTokensRef.current

    async function restorePersistedTimelines() {
      const persistedState = loadPersistedAppState()

      if (!persistedState) {
        persistenceReadyRef.current = true
        return
      }

      const restoredViewMode = isTimelineViewMode(persistedState.timelineViewMode)
        ? persistedState.timelineViewMode
        : "compact-timeline"

      setTimelineViewMode(restoredViewMode)
      setTimelines(
        persistedState.timelines.map((metadata) => createTimelinePlaceholder(metadata))
      )

      const restoredMetadata: PersistedTimelineMetadata[] = []
      let missingFileCount = 0

      for (const metadata of persistedState.timelines) {
        if (cancelled) {
          return
        }

        try {
          const storedBlob = await loadTimelineFile(metadata.id)

          if (cancelled) {
            return
          }

          if (!storedBlob) {
            missingFileCount += 1
            setTimelines((currentTimelines) =>
              currentTimelines.filter((timeline) => timeline.id !== metadata.id)
            )
            continue
          }

          restoredMetadata.push(metadata)
          await hydrateTimelineFromBlobRef.current(metadata, storedBlob, {
            persistFile: false,
          })
        } catch (error) {
          missingFileCount += 1
          setTimelines((currentTimelines) =>
            currentTimelines.filter((timeline) => timeline.id !== metadata.id)
          )
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to restore one of the stored files."
          )
        }
      }

      persistenceReadyRef.current = true
      savePersistedAppState({
        timelineViewMode: restoredViewMode,
        timelines: restoredMetadata,
      })

      if (missingFileCount > 0) {
        setErrorMessage(
          `${missingFileCount} stored timeline${
            missingFileCount === 1 ? "" : "s"
          } could not be restored and ${missingFileCount === 1 ? "was" : "were"} removed.`
        )
      }
    }

    void restorePersistedTimelines()

    return () => {
      cancelled = true
      timelineTaskTokens.clear()
    }
  }, [])

  useEffect(() => {
    if (!persistenceReadyRef.current) {
      return
    }

    try {
      savePersistedAppState({
        timelineViewMode,
        timelines: timelines.map(
          ({
            id,
            fileName,
            fileType,
            fileLastModified,
            bpmInput,
            crossfadeDurationInput,
            manualFadeInEnabled,
            manualFadeOutEnabled,
            trimInput,
            dslInput,
          }) => ({
            id,
            fileName,
            fileType,
            fileLastModified,
            bpmInput,
            crossfadeDurationInput,
            manualFadeInEnabled,
            manualFadeOutEnabled,
            trimInput,
            dslInput,
          })
        ),
      })
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to save timeline settings locally."
      )
    }
  }, [timelineViewMode, timelines])

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent) {
      handleSpacebarToggle(event)
    }

    window.addEventListener("keydown", handleWindowKeyDown)

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown)
    }
  }, [])

  useEffect(() => {
    return () => {
      stopPlaybackRef.current()

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

  const timelineCountLabel = `${timelines.length} ${
    timelines.length === 1 ? "track" : "tracks"
  }`

  const viewOptions: Array<{
    label: string
    value: TimelineViewMode
    icon: typeof ViewAgendaIcon
  }> = [
    { label: "Compact timeline", value: "compact-timeline", icon: ViewAgendaIcon },
    { label: "Grid", value: "grid", icon: LayoutGridIcon },
  ]

  const selectedTimelineStateOptions = selectedTimeline
    ? getStateOptions(selectedTimeline)
    : []
  const selectedTimelineFadeControlMode =
    playbackMode === "code" ? "readonly" : "editable"
  const selectedTimelineFadeControls = selectedTimeline
    ? selectedTimelineFadeControlMode === "readonly"
      ? getCodePlaybackFadeControls(selectedTimeline.id)
      : getManualFadeControls(selectedTimeline)
    : getDefaultFadeControls()
  const selectedTimelineActiveCodeState =
    selectedTimeline &&
    playbackMode === "code" &&
    activeSelection?.timelineId === selectedTimeline.id
      ? (codeRuntimeStatus?.currentStateName ?? null)
      : null
  const selectedTimelinePendingCodeState =
    selectedTimeline &&
    playbackMode === "code" &&
    activeSelection?.timelineId === selectedTimeline.id
      ? (codeRuntimeStatus?.pendingTargetStateName ?? null)
      : null

  function renderTimelineFadeToggle(
    field: keyof FadeControls,
    label: string
  ) {
    if (!selectedTimeline) {
      return null
    }

    const isOn = selectedTimelineFadeControls[field]
    const isEditable = selectedTimelineFadeControlMode === "editable"

    return (
      <button
        aria-label={
          isEditable
            ? `${isOn ? "Disable" : "Enable"} ${label.toLowerCase()} for free play`
            : `${label} ${isOn ? "enabled" : "disabled"}`
        }
        aria-pressed={isOn}
        className={cn(
          "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium uppercase tracking-[0.16em] transition-colors",
          isOn
            ? "border-emerald-300/70 bg-emerald-400/18 text-emerald-50"
            : "border-border/60 bg-black/20 text-foreground/72",
          isEditable
            ? "cursor-pointer hover:border-foreground/40 hover:bg-black/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
            : "cursor-default"
        )}
        disabled={!isEditable}
        onClick={() => {
          handleTimelineFadeToggle(selectedTimeline, field)
        }}
        type="button"
      >
        {label}
      </button>
    )
  }

  return (
    <>
      <Head>
        <title>Unshuffle Music</title>
        <meta
          content="Drop one or more tracks, set BPM and crossfade per track, then loop 16-beat sections across multiple timelines."
          name="description"
        />
      </Head>

      <div className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
        {isDragging ? (
          <div className="pointer-events-none fixed inset-4 z-50 rounded-2xl border border-primary/60 bg-primary/8 p-6">
            <div className="flex h-full items-center justify-center rounded-[calc(1rem-1px)] border border-dashed border-primary/40 bg-background/80">
              <div className="flex max-w-sm flex-col items-center gap-2 text-center">
                <p className="text-base font-semibold tracking-tight">
                  Drop audio to add new timelines
                </p>
                <p className="text-sm text-muted-foreground">
                  Release files anywhere on the page.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <main className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-[2rem]">
                    Audio loop slicer
                  </h1>
                  <Badge variant={timelines.length > 0 ? "secondary" : "outline"}>
                    {timelineCountLabel}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Drop audio anywhere, set BPM per track, and drive playback with
                  manual section picks or the music DSL.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
                <p className="text-sm text-muted-foreground">
                  {timelines.length > 0
                    ? "Drop more audio anywhere to add tracks."
                    : "Drop audio anywhere to start."}
                </p>
                <div className="flex items-center gap-1 rounded-lg bg-muted/30 p-1">
                  {viewOptions.map((option) => (
                    <Button
                      aria-label={option.label}
                      className="flex-1"
                      key={option.value}
                      onClick={() => setTimelineViewMode(option.value)}
                      size="sm"
                      title={option.label}
                      type="button"
                      variant={
                        timelineViewMode === option.value ? "secondary" : "ghost"
                      }
                    >
                      <HugeiconsIcon
                        data-icon="inline-start"
                        icon={option.icon}
                        size={14}
                      />
                      <span>
                        {option.label === "Compact timeline"
                          ? "Timeline"
                          : option.label}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            {errorMessage ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}
          </section>

          {selectedTimeline === null ? (
            <Card className="min-w-0">
              <CardContent className="min-h-48 items-center justify-center py-10 text-center">
                <p className="max-w-lg text-sm text-muted-foreground">
                  Drop audio files anywhere to add tracks. Track files, offsets, and
                  DSL text are restored locally after refresh when the browser allows
                  it.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-2" key={selectedTimeline.id}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 basis-64">
                  <Select
                    onValueChange={handleSelectedTimelineChange}
                    value={selectedTimeline.id}
                  >
                    <SelectTrigger
                      aria-label="Select track"
                      className="w-full max-w-sm"
                    >
                      <SelectValue placeholder="Select track" />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectGroup>
                        {preparedTimelines.map((timeline) => (
                          <SelectItem key={timeline.id} value={timeline.id}>
                            {timeline.fileName}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        aria-label={`Open settings for ${selectedTimeline.fileName}`}
                        size="icon-sm"
                        title={`Settings for ${selectedTimeline.fileName}`}
                        type="button"
                        variant="ghost"
                      >
                        <HugeiconsIcon icon={Settings01Icon} size={16} />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 p-3">
                      <div className="flex flex-col gap-3">
                        <p className="truncate text-sm font-semibold tracking-tight">
                          {selectedTimeline.fileName}
                        </p>

                        <FieldGroup className="gap-3">
                          <Field
                            className="max-w-xs"
                            data-invalid={
                              selectedTimeline.bpmInput !== "" &&
                              !selectedTimeline.bpmIsValid
                            }
                          >
                            <FieldLabel htmlFor={`bpm-input-${selectedTimeline.id}`}>
                              BPM
                            </FieldLabel>
                            <Input
                              aria-invalid={
                                selectedTimeline.bpmInput !== "" &&
                                !selectedTimeline.bpmIsValid
                              }
                              id={`bpm-input-${selectedTimeline.id}`}
                              inputMode="decimal"
                              onChange={(event) => {
                                handleTimelineBpmInputChange(
                                  selectedTimeline.id,
                                  event.target.value
                                )
                              }}
                              placeholder="128"
                              step="0.01"
                              type="number"
                              value={selectedTimeline.bpmInput}
                            />
                            <FieldDescription>
                              {selectedTimeline.loopDurationSec
                                ? `${formatDuration(
                                    selectedTimeline.loopDurationSec
                                  )} per 16-beat section`
                                : "Enter a positive BPM for this track."}
                            </FieldDescription>
                          </Field>

                          <Field
                            className="max-w-xs"
                            data-invalid={
                              selectedTimeline.crossfadeDurationInput !== "" &&
                              !selectedTimeline.crossfadeDurationIsValid
                            }
                          >
                            <div className="flex items-center justify-between gap-2">
                              <FieldLabel
                                htmlFor={`crossfade-duration-${selectedTimeline.id}`}
                              >
                                Crossfade
                              </FieldLabel>
                              <span className="text-xs text-muted-foreground">
                                ms
                              </span>
                            </div>
                            <Input
                              aria-invalid={
                                selectedTimeline.crossfadeDurationInput !== "" &&
                                !selectedTimeline.crossfadeDurationIsValid
                              }
                              id={`crossfade-duration-${selectedTimeline.id}`}
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => {
                                handleCrossfadeDurationInputChange(
                                  selectedTimeline.id,
                                  event.target.value
                                )
                              }}
                              placeholder={DEFAULT_CROSSFADE_DURATION_INPUT}
                              step="1"
                              type="number"
                              value={selectedTimeline.crossfadeDurationInput}
                            />
                            <FieldDescription>
                              {!selectedTimeline.crossfadeDurationIsValid
                                ? "Enter 0 or a positive duration."
                                : selectedTimeline.crossfadeDurationSec === 0
                                  ? "0 ms disables crossfade overlays for this track."
                                  : `${formatMilliseconds(
                                      selectedTimeline.crossfadeDurationValueMs
                                    )} fade-in and fade-out overlays.`}
                            </FieldDescription>
                          </Field>
                        </FieldGroup>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        aria-label={`Open trim settings for ${selectedTimeline.fileName}`}
                        size="icon-sm"
                        title={`Trim settings for ${selectedTimeline.fileName}`}
                        type="button"
                        variant="ghost"
                      >
                        <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-60 p-3">
                      <div className="flex flex-col gap-3">
                        <p className="truncate text-sm font-semibold tracking-tight">
                          {selectedTimeline.fileName}
                        </p>

                        <FieldGroup className="gap-2.5">
                          <Field
                            className="max-w-xs"
                            data-invalid={
                              selectedTimeline.trimInput !== "" &&
                              !selectedTimeline.trimHasValidRange
                            }
                          >
                            <div className="flex items-center justify-between gap-2">
                              <FieldLabel
                                htmlFor={`trim-input-${selectedTimeline.id}`}
                              >
                                Start
                              </FieldLabel>
                              <span className="text-xs text-muted-foreground">
                                ms
                              </span>
                            </div>
                            <Input
                              aria-invalid={
                                selectedTimeline.trimInput !== "" &&
                                !selectedTimeline.trimHasValidRange
                              }
                              className="h-8"
                              id={`trim-input-${selectedTimeline.id}`}
                              inputMode="numeric"
                              min="0"
                              onChange={(event) => {
                                handleTrimInputChange(
                                  selectedTimeline.id,
                                  event.target.value
                                )
                              }}
                              placeholder="0"
                              step="1"
                              type="number"
                              value={selectedTimeline.trimInput}
                            />
                            <FieldDescription>
                              {selectedTimeline.trimInput !== "" &&
                              !selectedTimeline.trimHasValidRange
                                ? "Choose a start inside the track."
                                : `Starts at ${formatMilliseconds(
                                    selectedTimeline.trimIsValid
                                      ? selectedTimeline.trimValue
                                      : 0
                                  )}.`}
                            </FieldDescription>
                          </Field>
                        </FieldGroup>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <Button
                    aria-label={`Remove ${selectedTimeline.fileName}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      void handleTimelineRemove(selectedTimeline.id)
                    }}
                    size="icon-sm"
                    title={`Remove ${selectedTimeline.fileName}`}
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={Delete01Icon} size={16} />
                  </Button>
                </div>
              </div>

              <p className="truncate text-sm text-muted-foreground">
                {getTimelineSummary(selectedTimeline)}
              </p>

              <Card
                className={cn(
                  "min-w-0",
                  activeSelection?.timelineId === selectedTimeline.id &&
                    "border-primary/20 bg-card/90"
                )}
              >
                <CardContent className="gap-4 px-4 py-4 sm:px-5 sm:py-5">
                  {selectedTimeline.errorMessage ? (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {selectedTimeline.errorMessage}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    {renderTimelineFadeToggle("fadeIn", "Fade in")}
                    {renderTimelineFadeToggle("fadeOut", "Fade out")}
                    <span className="text-xs text-muted-foreground">
                      {selectedTimelineFadeControlMode === "editable"
                        ? "Applies to free play on this track."
                        : "Showing fade flags from the current DSL transition."}
                    </span>
                  </div>

                  <AudioWaveform
                    activeSectionId={
                      activeSelection?.timelineId === selectedTimeline.id
                        ? activeSelection.sectionId
                        : null
                    }
                    activeSectionProgress={
                      activeSelection?.timelineId === selectedTimeline.id
                        ? activeSectionProgress
                        : 0
                    }
                    disabled={
                      selectedTimeline.isDecoding || !selectedTimeline.audioBuffer
                    }
                    durationSec={selectedTimeline.durationSec}
                    emptyMessage={selectedTimeline.message}
                    onSectionSelect={(section, options) => {
                      void handleSectionSelect(selectedTimeline, section, options)
                    }}
                    peaks={selectedTimeline.waveformPeaks}
                    pendingSectionId={
                      pendingSelection?.timelineId === selectedTimeline.id
                        ? pendingSelection.sectionId
                        : null
                    }
                    sections={selectedTimeline.sections}
                    trimSec={
                      selectedTimeline.trimIsValid
                        ? selectedTimeline.trimValue / 1000
                        : null
                    }
                    viewMode={timelineViewMode}
                  />

                  <FieldGroup className="gap-3">
                    <Field>
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel htmlFor={`dsl-input-${selectedTimeline.id}`}>
                          Music DSL
                        </FieldLabel>
                        <Badge
                          variant={
                            selectedTimeline.compiledProgram && !selectedTimeline.codeIsDirty
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {selectedTimeline.compiledProgram && !selectedTimeline.codeIsDirty
                            ? "Ready"
                            : selectedTimeline.codeIsDirty
                              ? "Dirty"
                              : "Uncompiled"}
                        </Badge>
                      </div>
                      <MusicDslEditor
                        id={`dsl-input-${selectedTimeline.id}`}
                        onChange={(dslInput) => {
                          handleDslInputChange(selectedTimeline.id, dslInput)
                        }}
                        placeholder={`explore: 1{a} (2 3)*3\ncombat: {a}!4 (5 6)+`}
                        value={selectedTimeline.dslInput}
                      />
                      <FieldDescription>
                        {selectedTimeline.codeIsDirty
                          ? "The editor has changes that have not been compiled against the current sections."
                          : selectedTimeline.compiledProgram
                            ? `Compiled ${getStateOptions(selectedTimeline).length.toString()} state${
                                getStateOptions(selectedTimeline).length === 1
                                  ? ""
                                  : "s"
                              } for this track.`
                            : "Run the code to validate it and enter code mode."}
                      </FieldDescription>
                    </Field>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        onClick={() => {
                          void handleRunCode(selectedTimeline)
                        }}
                        type="button"
                      >
                        Run
                      </Button>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline">
                            Compiled
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="w-[min(42rem,calc(100vw-2rem))] p-3"
                        >
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <p className="text-sm font-medium">
                                Compiled DSL debug
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {selectedTimeline.lastCompiledDslInput === null
                                  ? "Run the DSL to capture a compiled snapshot."
                                  : selectedTimeline.codeIsDirty
                                    ? "Showing the last successful compile. The editor has uncompiled changes."
                                    : "Showing the latest compiled snapshot for this timeline."}
                              </p>
                            </div>
                            <pre className="max-h-96 overflow-auto rounded-lg border border-border/50 bg-muted/20 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">
                              <code>{selectedTimelineDslDebugOutput}</code>
                            </pre>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>

                    {selectedTimelineStateOptions.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                          {selectedTimelineStateOptions.map((stateName) => {
                            const isCurrentState =
                              selectedTimelineActiveCodeState === stateName
                            const isPendingState =
                              selectedTimelinePendingCodeState === stateName
                            const isSelectedState =
                              selectedTimeline.selectedCodeState === stateName

                            return (
                              <Button
                                aria-pressed={isSelectedState}
                                className="h-auto min-h-12 justify-start px-3 py-2 text-left whitespace-normal"
                                key={stateName}
                                onClick={(event) => {
                                  void handleCodeStateButtonPress(
                                    selectedTimeline,
                                    stateName,
                                    {
                                      force: event.metaKey || event.ctrlKey,
                                    }
                                  )
                                }}
                                title="Click to queue goTo. Cmd/Ctrl+Click force-starts this state."
                                type="button"
                                variant={
                                  isCurrentState
                                    ? "default"
                                    : isPendingState
                                      ? "secondary"
                                      : isSelectedState
                                        ? "outline"
                                        : "ghost"
                                }
                              >
                                {stateName}
                              </Button>
                            )
                          })}
                        </div>
                        <FieldDescription>
                          Click a state to queue `goTo` while this timeline is
                          playing in code mode. Use Cmd/Ctrl+Click to force-play a
                          state immediately.
                        </FieldDescription>
                      </div>
                    ) : null}

                    {selectedTimeline.lastRunDiagnostics.length > 0 ? (
                      <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-muted/15 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">Diagnostics</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {
                                selectedTimeline.lastRunDiagnostics.filter(
                                  (diagnostic) =>
                                    diagnostic.severity === "error"
                                ).length
                              }{" "}
                              errors
                            </span>
                            <span>
                              {
                                selectedTimeline.lastRunDiagnostics.filter(
                                  (diagnostic) =>
                                    diagnostic.severity === "warning"
                                ).length
                              }{" "}
                              warnings
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col gap-2">
                          {selectedTimeline.lastRunDiagnostics.map((diagnostic) => (
                            <div
                              className={cn(
                                "rounded-lg border px-3 py-2 text-sm",
                                diagnostic.severity === "error"
                                  ? "border-destructive/20 bg-destructive/10 text-destructive"
                                  : "border-amber-300/30 bg-amber-300/10 text-amber-900 dark:text-amber-100"
                              )}
                              key={`${diagnostic.severity}-${diagnostic.line.toString()}-${diagnostic.column.toString()}-${diagnostic.message}`}
                            >
                              <p className="font-medium">
                                {diagnostic.severity === "error"
                                  ? "Error"
                                  : "Warning"}{" "}
                                · line {diagnostic.line.toString()}, col{" "}
                                {diagnostic.column.toString()}
                              </p>
                              <p>{diagnostic.message}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </FieldGroup>
                </CardContent>
              </Card>
            </div>
          )}
        </main>

        <Button
          aria-label={
            !activeSelection
              ? "Select a loop to play"
              : isPlaybackPaused
                ? "Resume playback (Space)"
                : "Pause playback (Space)"
          }
          className="fixed right-6 bottom-6 z-40 size-14 rounded-full shadow-lg sm:right-8 sm:bottom-8"
          disabled={!activeSelection}
          onClick={() => {
            void togglePlaybackPause()
          }}
          size="icon-lg"
          title={
            !activeSelection
              ? "Select a loop to play"
              : isPlaybackPaused
                ? "Resume playback (Space)"
                : "Pause playback (Space)"
          }
          type="button"
          variant={activeSelection ? "default" : "outline"}
        >
          <HugeiconsIcon
            icon={activeSelection && !isPlaybackPaused ? PauseIcon : PlayIcon}
            size={20}
          />
        </Button>
      </div>
    </>
  )
}
