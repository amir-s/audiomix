import { ChangeEvent, startTransition, useEffect, useRef, useState } from "react"
import Head from "next/head"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  LayoutGridIcon,
  PauseIcon,
  PlayIcon,
  ViewAgendaIcon,
} from "@hugeicons/core-free-icons"

import { AudioWaveform, TimelineViewMode } from "@/components/audio-waveform"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  AudioSection,
  createAudioSections,
  extractWaveformPeaks,
  formatDuration,
  formatMilliseconds,
  getSectionDurationSec,
} from "@/lib/audio"
import {
  deleteTimelineFile,
  loadPersistedAppState,
  loadTimelineFile,
  type PersistedTimelineMetadata,
  savePersistedAppState,
  saveTimelineFile,
} from "@/lib/timeline-storage"

type BrowserAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

type TimelineState = PersistedTimelineMetadata & {
  audioBuffer: AudioBuffer | null
  waveformPeaks: number[]
  isDecoding: boolean
  errorMessage: string | null
}

type TimelineSelection = {
  timelineId: string
  sectionId: string
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

  return "Click a section to loop it. Clicking a different section queues a switch at the next loop boundary."
}

function createLoopSource(
  audioContext: AudioContext,
  audioBuffer: AudioBuffer,
  section: AudioSection
) {
  const source = audioContext.createBufferSource()
  source.buffer = audioBuffer
  source.loop = true
  source.loopStart = section.startSec
  source.loopEnd = section.endSec
  source.connect(audioContext.destination)
  source.addEventListener("ended", () => {
    try {
      source.disconnect()
    } catch {}
  })

  return source
}

function safeStopSource(source: AudioBufferSourceNode | null, when?: number) {
  if (!source) {
    return
  }

  try {
    if (typeof when === "number") {
      source.stop(when)
    } else {
      source.stop()
    }
  } catch {}

  try {
    source.disconnect()
  } catch {}
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const bpmInputRef = useRef<HTMLInputElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const scheduledSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const switchTimeoutRef = useRef<number | null>(null)
  const sourceStartedAtRef = useRef<number | null>(null)
  const sourceDurationRef = useRef<number | null>(null)
  const dragDepthRef = useRef(0)
  const addFilesRef = useRef<(files: File[]) => Promise<void>>(async () => undefined)
  const hydrateTimelineFromBlobRef =
    useRef<HydrateTimelineFromBlob>(async () => undefined)
  const timelineTaskTokensRef = useRef(new Map<string, number>())
  const taskCounterRef = useRef(0)
  const persistenceReadyRef = useRef(false)
  const stopPlaybackRef = useRef<(clearActive?: boolean) => void>(() => undefined)

  const [timelines, setTimelines] = useState<TimelineState[]>([])
  const [bpmInput, setBpmInput] = useState("")
  const [isDragging, setIsDragging] = useState(false)
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
    }
  })

  const timelineMap = new Map(
    preparedTimelines.map((timeline) => [timeline.id, timeline] as const)
  )

  const activeTimeline = activeSelection
    ? (timelineMap.get(activeSelection.timelineId) ?? null)
    : null
  const activeSection =
    activeTimeline?.sections.find(
      (section) => section.id === activeSelection?.sectionId
    ) ?? null
  const pendingTimeline = pendingSelection
    ? (timelineMap.get(pendingSelection.timelineId) ?? null)
    : null
  const pendingSection =
    pendingTimeline?.sections.find(
      (section) => section.id === pendingSelection?.sectionId
    ) ?? null
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

  function createTaskToken(timelineId: string) {
    const nextToken = taskCounterRef.current + 1
    taskCounterRef.current = nextToken
    timelineTaskTokensRef.current.set(timelineId, nextToken)
    return nextToken
  }

  function isTaskCurrent(timelineId: string, token: number) {
    return timelineTaskTokensRef.current.get(timelineId) === token
  }

  stopPlaybackRef.current = (clearActive = true) => {
    if (switchTimeoutRef.current) {
      window.clearTimeout(switchTimeoutRef.current)
      switchTimeoutRef.current = null
    }

    safeStopSource(scheduledSourceRef.current)
    safeStopSource(currentSourceRef.current)

    scheduledSourceRef.current = null
    currentSourceRef.current = null
    sourceStartedAtRef.current = null
    sourceDurationRef.current = null

    updatePendingSelection(null)
    setIsPlaybackPaused(false)
    setActiveSectionProgress(0)

    if (clearActive) {
      updateActiveSelection(null)
    }
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

  async function startLoopNow(timeline: PreparedTimeline, section: AudioSection) {
    if (!timeline.audioBuffer) {
      return
    }

    try {
      const audioContext = await ensureAudioContext()
      const source = createLoopSource(audioContext, timeline.audioBuffer, section)
      const startTime = audioContext.currentTime + 0.01
      const nextSelection = {
        timelineId: timeline.id,
        sectionId: section.id,
      }

      stopPlaybackRef.current(false)

      source.start(startTime, section.startSec)
      currentSourceRef.current = source
      sourceStartedAtRef.current = startTime
      sourceDurationRef.current = section.endSec - section.startSec

      updateActiveSelection(nextSelection)
      setActiveSectionProgress(0)
      setIsPlaybackPaused(false)
      updatePendingSelection(null)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start playback."
      )
    }
  }

  async function scheduleLoopSwitch(
    timeline: PreparedTimeline,
    section: AudioSection
  ) {
    if (!timeline.audioBuffer || !currentSourceRef.current) {
      await startLoopNow(timeline, section)
      return
    }

    const startedAt = sourceStartedAtRef.current
    const currentDuration = sourceDurationRef.current
    const nextSelection = {
      timelineId: timeline.id,
      sectionId: section.id,
    }

    if (startedAt === null || currentDuration === null) {
      await startLoopNow(timeline, section)
      return
    }

    try {
      const audioContext = await ensureAudioContext()
      const nextSource = createLoopSource(audioContext, timeline.audioBuffer, section)
      const now = audioContext.currentTime
      const elapsed = Math.max(0, now - startedAt)
      const completedLoops = Math.max(1, Math.ceil(elapsed / currentDuration))
      let boundaryTime = startedAt + completedLoops * currentDuration

      if (boundaryTime <= now + 0.01) {
        boundaryTime += currentDuration
      }

      if (switchTimeoutRef.current) {
        window.clearTimeout(switchTimeoutRef.current)
      }

      safeStopSource(scheduledSourceRef.current)

      try {
        currentSourceRef.current.stop(boundaryTime)
      } catch {}

      nextSource.start(boundaryTime, section.startSec)
      scheduledSourceRef.current = nextSource

      switchTimeoutRef.current = window.setTimeout(() => {
        currentSourceRef.current = nextSource
        scheduledSourceRef.current = null
        sourceStartedAtRef.current = boundaryTime
        sourceDurationRef.current = section.endSec - section.startSec
        updateActiveSelection(nextSelection)
        setActiveSectionProgress(0)
        updatePendingSelection(null)
        switchTimeoutRef.current = null
      }, Math.max(0, (boundaryTime - now) * 1000) + 24)

      updatePendingSelection(nextSelection)
      setIsPlaybackPaused(false)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to queue the next loop."
      )
    }
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

  async function handleSectionSelect(
    timeline: PreparedTimeline,
    section: AudioSection
  ) {
    const nextSelectionKey = createSelectionKey({
      timelineId: timeline.id,
      sectionId: section.id,
    })

    if (nextSelectionKey === pendingSelectionKey) {
      return
    }

    if (nextSelectionKey === activeSelectionKey) {
      await startLoopNow(timeline, section)
      return
    }

    if (!activeSelection) {
      await startLoopNow(timeline, section)
      return
    }

    await scheduleLoopSwitch(timeline, section)
  }

  function handleBrowseClick() {
    fileInputRef.current?.click()
  }

  async function handleInputFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])

    event.target.value = ""

    if (files.length === 0) {
      return
    }

    await addFiles(files)
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

  async function handleTimelineRemove(timelineId: string) {
    timelineTaskTokensRef.current.delete(timelineId)

    setTimelines((currentTimelines) =>
      currentTimelines.filter((timeline) => timeline.id !== timelineId)
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
      const startedAt = sourceStartedAtRef.current
      const duration = sourceDurationRef.current

      if (!audioContext || startedAt === null || !duration) {
        setActiveSectionProgress(0)
        return
      }

      const elapsed = Math.max(0, audioContext.currentTime - startedAt)
      const progress = duration > 0 ? (elapsed % duration) / duration : 0

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
          ({ id, fileName, fileType, fileLastModified, trimInput }) => ({
            id,
            fileName,
            fileType,
            fileLastModified,
            trimInput,
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
    return () => {
      stopPlaybackRef.current()

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

  const transportMessage = (() => {
    if (pendingTimeline && pendingSection) {
      return `Queued next: ${pendingTimeline.fileName} · ${
        pendingSection.label
      } · ${formatMilliseconds(pendingSection.startMs)} to ${formatMilliseconds(
        pendingSection.endMs
      )}.`
    }

    if (activeTimeline && activeSection) {
      return `${isPlaybackPaused ? "Paused" : "Looping"} ${
        activeTimeline.fileName
      } · ${activeSection.label} · ${formatMilliseconds(
        activeSection.startMs
      )} to ${formatMilliseconds(activeSection.endMs)}.`
    }

    return "Select any section. Clicking a different section queues it at the next loop boundary on the shared output."
  })()

  const viewOptions: Array<{
    label: string
    value: TimelineViewMode
    icon: typeof ViewAgendaIcon
  }> = [
    { label: "Compact timeline", value: "compact-timeline", icon: ViewAgendaIcon },
    { label: "Grid", value: "grid", icon: LayoutGridIcon },
  ]

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
                  Release one or more files anywhere on the page. Each file becomes its own timeline.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <main className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex max-w-3xl flex-col gap-2">
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  Audio loop slicer
                </h1>
                <p className="text-sm text-muted-foreground sm:text-base">
                  Drop tracks anywhere on the page, set one BPM for all of them, then
                  build exact 16-beat loops on separate timelines.
                </p>
                <p className="text-sm text-muted-foreground">
                  {timelines.length > 0
                    ? `${timelines.length} timeline${
                        timelines.length === 1 ? "" : "s"
                      } loaded. Drop more audio anywhere or choose more files locally.`
                    : "No tracks loaded yet. Drop audio files anywhere or choose them locally."}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleBrowseClick} type="button">
                  Choose files
                </Button>
              </div>
            </div>

            <input
              accept="audio/*"
              className="sr-only"
              onChange={handleInputFileChange}
              multiple
              ref={fileInputRef}
              type="file"
            />

            {errorMessage ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}
          </section>

          <Card className="min-w-0">
            <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-1.5">
                <CardTitle>Shared loop settings</CardTitle>
                <CardDescription>
                  BPM applies to every timeline. Any section from any song can be queued next on the shared output.
                </CardDescription>
              </div>
              <div className="flex items-center gap-1 self-start rounded-lg border border-border/70 bg-muted/20 p-1">
                {viewOptions.map((option) => (
                  <Button
                    aria-label={option.label}
                    key={option.value}
                    onClick={() => setTimelineViewMode(option.value)}
                    size="icon-sm"
                    title={option.label}
                    type="button"
                    variant={
                      timelineViewMode === option.value ? "secondary" : "ghost"
                    }
                  >
                    <HugeiconsIcon icon={option.icon} size={16} />
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)] md:items-end">
                <Field data-invalid={bpmInput !== "" && !bpmIsValid} className="max-w-xs">
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
                      ? `Each loop is ${formatDuration(loopDurationSec)} long.`
                      : "Enter a positive BPM to generate 16-beat sections."}
                  </FieldDescription>
                </Field>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    aria-label={isPlaybackPaused ? "Resume loop" : "Pause loop"}
                    disabled={!activeSection}
                    onClick={togglePlaybackPause}
                    size="icon-lg"
                    title={isPlaybackPaused ? "Resume loop" : "Pause loop"}
                    type="button"
                    variant="outline"
                  >
                    <HugeiconsIcon
                      icon={isPlaybackPaused ? PlayIcon : PauseIcon}
                      size={18}
                    />
                  </Button>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {transportMessage}
                  </p>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                {loopDurationSec
                  ? `All timelines currently slice into ${formatDuration(
                      loopDurationSec
                    )} sections. Tail audio shorter than one full section is hidden.`
                  : "Set BPM once, then adjust each timeline start time independently."}
              </p>
            </CardContent>
          </Card>

          {preparedTimelines.length === 0 ? (
            <Card className="min-w-0">
              <CardContent className="min-h-48 items-center justify-center py-10 text-center">
                <p className="max-w-lg text-sm text-muted-foreground">
                  Drop one or more audio files anywhere on the page to create separate
                  timelines. Files and per-timeline start times will be restored after a
                  refresh when the browser can persist them locally.
                </p>
              </CardContent>
            </Card>
          ) : (
            preparedTimelines.map((timeline) => (
              <Card className="min-w-0" key={timeline.id}>
                <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate">{timeline.fileName}</CardTitle>
                    <CardDescription>
                      {timeline.isDecoding
                        ? "Decoding audio and building waveform peaks..."
                        : timeline.audioBuffer
                          ? `${formatDuration(timeline.audioBuffer.duration)} · ${
                              timeline.sections.length
                            } playable section${
                              timeline.sections.length === 1 ? "" : "s"
                            }.`
                          : "This file is waiting for audio data."}
                    </CardDescription>
                  </div>
                  <Button
                    aria-label={`Remove ${timeline.fileName}`}
                    onClick={() => {
                      void handleTimelineRemove(timeline.id)
                    }}
                    size="icon-sm"
                    title={`Remove ${timeline.fileName}`}
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={14} />
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)] md:items-end">
                    <Field
                      className="max-w-xs"
                      data-invalid={timeline.trimInput !== "" && !timeline.trimHasValidRange}
                    >
                      <FieldLabel htmlFor={`trim-input-${timeline.id}`}>
                        Start time (ms)
                      </FieldLabel>
                      <Input
                        aria-invalid={timeline.trimInput !== "" && !timeline.trimHasValidRange}
                        id={`trim-input-${timeline.id}`}
                        inputMode="numeric"
                        min="0"
                        onChange={(event) => {
                          handleTrimInputChange(timeline.id, event.target.value)
                        }}
                        placeholder="0"
                        step="1"
                        type="number"
                        value={timeline.trimInput}
                      />
                      <FieldDescription>
                        {timeline.audioBuffer && timeline.trimIsValid
                          ? `First section starts at ${formatMilliseconds(
                              timeline.trimValue
                            )}.`
                          : "Offset the first generated section from this file's start."}
                      </FieldDescription>
                    </Field>

                    <p className="max-w-2xl text-xs text-muted-foreground">
                      {timeline.sections.length > 0
                        ? `${timeline.sections.length} section${
                            timeline.sections.length === 1 ? "" : "s"
                          } can be queued from this timeline.`
                        : "This timeline will populate once the shared BPM and local start time produce full 16-beat sections."}
                    </p>
                  </div>

                  {timeline.errorMessage ? (
                    <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {timeline.errorMessage}
                    </div>
                  ) : null}

                  <AudioWaveform
                    activeSectionId={
                      activeSelection?.timelineId === timeline.id
                        ? activeSelection.sectionId
                        : null
                    }
                    activeSectionProgress={
                      activeSelection?.timelineId === timeline.id
                        ? activeSectionProgress
                        : 0
                    }
                    disabled={timeline.isDecoding || !timeline.audioBuffer}
                    durationSec={timeline.durationSec}
                    emptyMessage={timeline.message}
                    onSectionSelect={(section) => {
                      void handleSectionSelect(timeline, section)
                    }}
                    peaks={timeline.waveformPeaks}
                    pendingSectionId={
                      pendingSelection?.timelineId === timeline.id
                        ? pendingSelection.sectionId
                        : null
                    }
                    sections={timeline.sections}
                    trimSec={timeline.trimIsValid ? timeline.trimValue / 1000 : null}
                    viewMode={timelineViewMode}
                  />
                </CardContent>
              </Card>
            ))
          )}
        </main>
      </div>
    </>
  )
}
