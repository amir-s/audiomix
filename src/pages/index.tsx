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
import { Textarea } from "@/components/ui/textarea"
import {
  AudioSection,
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

type PlaybackTarget = {
  timelineId: string
  section: AudioSection
  stateName: string | null
}

type ScheduledPlaybackItem = PlaybackTarget & {
  startTime: number
}

type HydrateTimelineFromBlob = (
  metadata: PersistedTimelineMetadata,
  blob: Blob,
  options: { persistFile: boolean }
) => Promise<void>

type PreparedTimeline = TimelineState & {
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

export default function Home() {
  const bpmInputRef = useRef<HTMLInputElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const scheduledSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const currentPlaybackRef = useRef<ScheduledPlaybackItem | null>(null)
  const scheduledPlaybackRef = useRef<ScheduledPlaybackItem | null>(null)
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
  const [bpmInput, setBpmInput] = useState("")
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

  const bpmValue = Number.parseFloat(bpmInput)
  const bpmIsValid = Number.isFinite(bpmValue) && bpmValue > 0
  const loopDurationSec = bpmIsValid ? getSectionDurationSec(bpmValue) : null

  const preparedTimelines: PreparedTimeline[] = timelines.map((timeline) => {
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
    stateName: string | null
  ) {
    return {
      timelineId: timeline.id,
      section,
      stateName,
    } satisfies PlaybackTarget
  }

  function getCodeTargetFromStatus(
    timeline: PreparedTimeline,
    status: NavigatorStatus,
    field: "current" | "next"
  ) {
    const sectionNumber =
      field === "current" ? status.currentSection : status.nextSection
    const stateName =
      field === "current" ? status.currentStateName : status.nextStateName

    if (sectionNumber === null || stateName === null) {
      return null
    }

    const section = timeline.sections[sectionNumber - 1] ?? null

    if (!section) {
      return null
    }

    return createPlaybackTarget(timeline, section, stateName)
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

    if (!bpmIsValid) {
      window.requestAnimationFrame(() => {
        bpmInputRef.current?.focus()
        bpmInputRef.current?.select()
      })
    }

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

    if (nextTarget && boundaryTime <= audioContext.currentTime + 0.03) {
      return false
    }

    if (!nextTarget) {
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

    safeStopSource(scheduledSourceRef.current)
    scheduledSourceRef.current = queuedSource
    scheduledPlaybackRef.current = queuedItem
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

      followingTarget = getCodeTargetFromStatus(timeline, status, "next")
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
    safeStopSource(scheduledSourceRef.current)
    safeStopSource(currentSourceRef.current)
    currentSourceRef.current = null
    scheduledSourceRef.current = null
    currentPlaybackRef.current = null
    scheduledPlaybackRef.current = null
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
    const target = createPlaybackTarget(timeline, section, null)

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

    const target = createPlaybackTarget(timeline, section, null)
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
    const currentTarget = getCodeTargetFromStatus(timeline, status, "current")

    if (!currentTarget) {
      throw new Error(`State '${stateName}' does not point to a playable section.`)
    }

    const nextTarget = getCodeTargetFromStatus(timeline, status, "next")

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

    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        (target.tagName === "BUTTON" && !isWaveformSectionTarget))
    ) {
      return
    }

    if (isWaveformSectionTarget) {
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
      bpm: bpmIsValid ? bpmValue : 0,
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

      const nextTarget = getCodeTargetFromStatus(timeline, status, "next")
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

  function handleCodeStateSelection(timelineId: string, stateName: string) {
    updateTimeline(timelineId, (timeline) => ({
      ...timeline,
      selectedCodeState: stateName,
    }))
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

      setBpmInput(persistedState.bpmInput)
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
        bpmInput: persistedState.bpmInput,
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
        bpmInput,
        timelineViewMode,
        timelines: timelines.map(
          ({
            id,
            fileName,
            fileType,
            fileLastModified,
            trimInput,
            dslInput,
          }) => ({
            id,
            fileName,
            fileType,
            fileLastModified,
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
  }, [bpmInput, timelineViewMode, timelines])

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

  const runtimeCurrentSectionLabel =
    activeSelection && selectedTimeline && activeSelection.timelineId === selectedTimeline.id
      ? selectedTimeline.sections.find(
          (section) => section.id === activeSelection.sectionId
        )?.label ?? "—"
      : "—"
  const runtimeQueuedSectionLabel =
    pendingSelection &&
    selectedTimeline &&
    pendingSelection.timelineId === selectedTimeline.id
      ? selectedTimeline.sections.find(
          (section) => section.id === pendingSelection.sectionId
        )?.label ?? "—"
      : "—"

  return (
    <>
      <Head>
        <title>Unshuffle Music</title>
        <meta
          content="Drop one or more tracks, set a shared BPM, then loop 16-beat sections across multiple timelines."
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
                  Drop audio anywhere, set one BPM, and drive playback with manual
                  section picks or the music DSL.
                </p>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-center">
                <p className="text-sm text-muted-foreground">
                  {timelines.length > 0
                    ? "Drop more audio anywhere to add tracks."
                    : "Drop audio anywhere to start."}
                </p>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      aria-label="Open shared loop settings"
                      size="icon-sm"
                      title="Shared loop settings"
                      type="button"
                      variant="ghost"
                    >
                      <HugeiconsIcon icon={Settings01Icon} size={16} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 p-3">
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-semibold tracking-tight">
                        Shared settings
                      </p>

                      <FieldGroup className="gap-3">
                        <Field
                          className="max-w-xs"
                          data-invalid={bpmInput !== "" && !bpmIsValid}
                        >
                          <FieldLabel htmlFor="bpm-input">BPM</FieldLabel>
                          <Input
                            aria-invalid={bpmInput !== "" && !bpmIsValid}
                            id="bpm-input"
                            inputMode="decimal"
                            onChange={(event) => {
                              stopPlaybackRef.current()
                              setBpmInput(event.target.value)
                            }}
                            placeholder="128"
                            ref={bpmInputRef}
                            step="0.01"
                            type="number"
                            value={bpmInput}
                          />
                          <FieldDescription>
                            {loopDurationSec
                              ? `${formatDuration(loopDurationSec)} per section`
                              : "Enter a positive BPM"}
                          </FieldDescription>
                        </Field>

                        <Field>
                          <FieldLabel>View</FieldLabel>
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
                                  timelineViewMode === option.value
                                    ? "secondary"
                                    : "ghost"
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
                        </Field>
                      </FieldGroup>
                    </div>
                  </PopoverContent>
                </Popover>
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

                  <div className="grid gap-2 rounded-xl border border-border/50 bg-muted/15 p-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Mode</span>
                      <span className="font-medium">
                        {activeSelection?.timelineId === selectedTimeline.id
                          ? playbackMode === "code"
                            ? "Code"
                            : "Manual"
                          : "Idle"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Current state</span>
                      <span className="font-medium">
                        {playbackMode === "code" &&
                        activeSelection?.timelineId === selectedTimeline.id
                          ? (codeRuntimeStatus?.currentStateName ?? "—")
                          : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Queued state</span>
                      <span className="font-medium">
                        {playbackMode === "code" &&
                        activeSelection?.timelineId === selectedTimeline.id
                          ? (codeRuntimeStatus?.nextStateName ?? "—")
                          : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Current section</span>
                      <span className="font-medium">{runtimeCurrentSectionLabel}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">Queued section</span>
                      <span className="font-medium">{runtimeQueuedSectionLabel}</span>
                    </div>
                    {playbackMode === "code" &&
                    activeSelection?.timelineId === selectedTimeline.id &&
                    codeRuntimeStatus?.pendingTargetStateName ? (
                      <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-5">
                        <span className="text-muted-foreground">Buffered goTo</span>
                        <span className="font-medium">
                          {codeRuntimeStatus.pendingTargetStateName}
                        </span>
                      </div>
                    ) : null}
                  </div>

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
                      <Textarea
                        className="min-h-40 font-mono text-xs"
                        id={`dsl-input-${selectedTimeline.id}`}
                        onChange={(event) => {
                          handleDslInputChange(
                            selectedTimeline.id,
                            event.target.value
                          )
                        }}
                        placeholder={`explore: 1{a} (2 3)+\ncombat: {a}4 (5 6)+`}
                        spellCheck={false}
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

                      <div className="min-w-44 flex-1 sm:flex-none">
                        <Select
                          onValueChange={(value) => {
                            handleCodeStateSelection(selectedTimeline.id, value)
                          }}
                          value={
                            selectedTimeline.selectedCodeState ??
                            getStateOptions(selectedTimeline)[0] ??
                            ""
                          }
                        >
                          <SelectTrigger
                            aria-label="Select code state"
                            className="w-full"
                            disabled={getStateOptions(selectedTimeline).length === 0}
                          >
                            <SelectValue placeholder="Select state" />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectGroup>
                              {getStateOptions(selectedTimeline).map((stateName) => (
                                <SelectItem key={stateName} value={stateName}>
                                  {stateName}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </div>

                      <Button
                        disabled={
                          !selectedTimeline.compiledProgram ||
                          selectedTimeline.codeIsDirty ||
                          !selectedTimeline.selectedCodeState
                        }
                        onClick={() => {
                          if (selectedTimeline.selectedCodeState) {
                            void handlePlayCodeState(
                              selectedTimeline,
                              selectedTimeline.selectedCodeState
                            )
                          }
                        }}
                        type="button"
                        variant="secondary"
                      >
                        Play state
                      </Button>

                      <Button
                        disabled={
                          !selectedTimeline.compiledProgram ||
                          selectedTimeline.codeIsDirty ||
                          !selectedTimeline.selectedCodeState ||
                          playbackMode !== "code" ||
                          activeSelection?.timelineId !== selectedTimeline.id
                        }
                        onClick={() => {
                          if (selectedTimeline.selectedCodeState) {
                            void handleGoToState(
                              selectedTimeline,
                              selectedTimeline.selectedCodeState
                            )
                          }
                        }}
                        type="button"
                        variant="outline"
                      >
                        Go to state
                      </Button>
                    </div>

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
