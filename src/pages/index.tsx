import { ChangeEvent, startTransition, useEffect, useRef, useState } from "react"
import Head from "next/head"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  LayoutGridIcon,
  PauseIcon,
  PlayIcon,
  TimelineIcon,
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  AudioSection,
  createAudioSections,
  extractWaveformPeaks,
  formatDuration,
  formatMilliseconds,
  getSectionDurationSec,
} from "@/lib/audio"

type BrowserAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
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
  const loadAudioFileRef = useRef<(file: File) => Promise<void>>(async () => undefined)
  const loadTokenRef = useRef(0)
  const stopPlaybackRef = useRef<(clearActive?: boolean) => void>(() => undefined)

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null)
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [bpmInput, setBpmInput] = useState("")
  const [trimInput, setTrimInput] = useState("0")
  const [isDragging, setIsDragging] = useState(false)
  const [isDecoding, setIsDecoding] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [shouldFocusBpm, setShouldFocusBpm] = useState(false)
  const [timelineViewMode, setTimelineViewMode] =
    useState<TimelineViewMode>("compact-timeline")
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false)
  const [activeSectionProgress, setActiveSectionProgress] = useState(0)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [pendingSectionId, setPendingSectionId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const bpmValue = Number.parseFloat(bpmInput)
  const trimValue = Number.parseFloat(trimInput)
  const bpmIsValid = Number.isFinite(bpmValue) && bpmValue > 0
  const trimIsValid = Number.isFinite(trimValue) && trimValue >= 0
  const durationSec = audioBuffer?.duration ?? 0
  const trimWithinDuration = trimIsValid && durationSec > 0 && trimValue / 1000 < durationSec
  const trimHasValidRange = trimIsValid && (!audioBuffer || trimWithinDuration)
  const sections =
    audioBuffer && bpmIsValid && trimIsValid
      ? createAudioSections({
          bpm: bpmValue,
          trimMs: trimValue,
          durationSec: audioBuffer.duration,
        })
      : []
  const loopDurationSec = bpmIsValid ? getSectionDurationSec(bpmValue) : null
  const activeSection = sections.find((section) => section.id === activeSectionId) ?? null

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

    setPendingSectionId(null)
    setIsPlaybackPaused(false)
    setActiveSectionProgress(0)

    if (clearActive) {
      setActiveSectionId(null)
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

  async function loadAudioFile(file: File) {
    if (file.type && !file.type.startsWith("audio/")) {
      setErrorMessage("Choose an audio file so the browser can decode it.")
      return
    }

    const nextLoadToken = loadTokenRef.current + 1
    loadTokenRef.current = nextLoadToken

    stopPlaybackRef.current()
    setSelectedFile(file)
    setAudioBuffer(null)
    setWaveformPeaks([])
    setErrorMessage(null)
    setIsDecoding(true)
    setIsSettingsOpen(true)
    setShouldFocusBpm(true)

    try {
      const audioContext = await ensureAudioContext({ resume: false })
      const fileBytes = await file.arrayBuffer()
      const decodedBuffer = await audioContext.decodeAudioData(fileBytes.slice(0))

      if (loadTokenRef.current !== nextLoadToken) {
        return
      }

      const peaks = extractWaveformPeaks(decodedBuffer)

      startTransition(() => {
        setAudioBuffer(decodedBuffer)
        setWaveformPeaks(peaks)
      })
    } catch (error) {
      if (loadTokenRef.current !== nextLoadToken) {
        return
      }

      setAudioBuffer(null)
      setWaveformPeaks([])
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The browser could not decode that audio file."
      )
    } finally {
      if (loadTokenRef.current === nextLoadToken) {
        setIsDecoding(false)
      }
    }
  }

  loadAudioFileRef.current = loadAudioFile

  async function startLoopNow(section: AudioSection) {
    if (!audioBuffer) {
      return
    }

    try {
      const audioContext = await ensureAudioContext()
      const source = createLoopSource(audioContext, audioBuffer, section)
      const startTime = audioContext.currentTime + 0.01

      stopPlaybackRef.current(false)

      source.start(startTime, section.startSec)
      currentSourceRef.current = source
      sourceStartedAtRef.current = startTime
      sourceDurationRef.current = section.endSec - section.startSec

      setActiveSectionId(section.id)
      setActiveSectionProgress(0)
      setIsPlaybackPaused(false)
      setPendingSectionId(null)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to start playback."
      )
    }
  }

  async function scheduleLoopSwitch(section: AudioSection) {
    if (!audioBuffer || !currentSourceRef.current) {
      await startLoopNow(section)
      return
    }

    const startedAt = sourceStartedAtRef.current
    const currentDuration = sourceDurationRef.current

    if (startedAt === null || currentDuration === null) {
      await startLoopNow(section)
      return
    }

    try {
      const audioContext = await ensureAudioContext()
      const nextSource = createLoopSource(audioContext, audioBuffer, section)
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
        setActiveSectionId(section.id)
        setActiveSectionProgress(0)
        setPendingSectionId(null)
        switchTimeoutRef.current = null
      }, Math.max(0, (boundaryTime - now) * 1000) + 24)

      setPendingSectionId(section.id)
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

    if (!audioContext || !activeSectionId) {
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

  async function handleSectionSelect(section: AudioSection) {
    if (section.id === pendingSectionId) {
      return
    }

    if (section.id === activeSectionId) {
      await startLoopNow(section)
      return
    }

    if (!activeSectionId) {
      await startLoopNow(section)
      return
    }

    await scheduleLoopSwitch(section)
  }

  function handleBrowseClick() {
    fileInputRef.current?.click()
  }

  async function handleInputFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    event.target.value = ""

    if (!file) {
      return
    }

    await loadAudioFile(file)
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

      const file = event.dataTransfer?.files?.[0]

      if (!file) {
        return
      }

      void loadAudioFileRef.current(file)
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
    if (!isSettingsOpen || !shouldFocusBpm) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      bpmInputRef.current?.focus()
      bpmInputRef.current?.select()
      setShouldFocusBpm(false)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [isSettingsOpen, shouldFocusBpm])

  useEffect(() => {
    if (!activeSectionId) {
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
  }, [activeSectionId, isPlaybackPaused])

  useEffect(() => {
    return () => {
      stopPlaybackRef.current()

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

  const waveformMessage = (() => {
    if (!selectedFile) {
      return "Drop an audio file anywhere on the page to render the waveform and create loop sections."
    }

    if (isDecoding) {
      return "Decoding audio and calculating waveform peaks..."
    }

    if (!audioBuffer) {
      return "The file is loaded, but waveform decoding did not complete."
    }

    if (!bpmIsValid) {
      return "Enter a positive BPM value to split the waveform into 16-beat sections."
    }

    if (!trimIsValid) {
      return "Enter a trim value in milliseconds starting from 0."
    }

    if (!trimWithinDuration) {
      return "Set the trim inside the loaded file duration to generate sections."
    }

    if (sections.length === 0) {
      return "No full 16-beat sections fit after the selected trim point."
    }

    return "Click a section to loop it. Clicking a different section queues a switch at the next loop boundary."
  })()

  const viewOptions: Array<{
    label: string
    value: TimelineViewMode
    icon: typeof ViewAgendaIcon
  }> = [
    { label: "Compact timeline", value: "compact-timeline", icon: ViewAgendaIcon },
    { label: "Timeline", value: "timeline", icon: TimelineIcon },
    { label: "Grid", value: "grid", icon: LayoutGridIcon },
  ]

  return (
    <>
      <Head>
        <title>Unshuffle Music</title>
        <meta
          content="Drop a track, set BPM and trim, then loop 16-beat sections from the waveform."
          name="description"
        />
      </Head>

      <div className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
        {isDragging ? (
          <div className="pointer-events-none fixed inset-4 z-50 rounded-2xl border border-primary/60 bg-primary/8 p-6">
            <div className="flex h-full items-center justify-center rounded-[calc(1rem-1px)] border border-dashed border-primary/40 bg-background/80">
              <div className="flex max-w-sm flex-col items-center gap-2 text-center">
                <p className="text-base font-semibold tracking-tight">
                  Drop audio to replace the current track
                </p>
                <p className="text-sm text-muted-foreground">
                  Release anywhere on the page. The waveform and sections will refresh in place.
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
                  Drop a track anywhere on the page, then set BPM and a trim offset to
                  build exact 16-beat loops on the timeline.
                </p>
                <p className="text-sm text-muted-foreground">
                  {selectedFile
                    ? `Loaded ${selectedFile.name}${
                        audioBuffer ? ` · ${formatDuration(audioBuffer.duration)}` : ""
                      }. Drop a new file anywhere to replace it.`
                    : "No track loaded yet. Drop an audio file anywhere or choose one locally."}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleBrowseClick} type="button">
                  Choose file
                </Button>

                <Popover onOpenChange={setIsSettingsOpen} open={isSettingsOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline">
                      Loop settings
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        <h2 className="text-sm font-semibold tracking-tight">Loop settings</h2>
                        <p className="text-xs text-muted-foreground">
                          Sections are fixed to 16 beats. Tail audio shorter than one full section is hidden.
                        </p>
                      </div>

                      <FieldGroup>
                        <Field data-invalid={bpmInput !== "" && !bpmIsValid}>
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

                        <Field data-invalid={trimInput !== "" && !trimHasValidRange}>
                          <FieldLabel htmlFor="trim-input">Start trim (ms)</FieldLabel>
                          <Input
                            aria-invalid={trimInput !== "" && !trimHasValidRange}
                            id="trim-input"
                            inputMode="numeric"
                            min="0"
                            onChange={(event) => {
                              stopPlaybackRef.current()
                              setTrimInput(event.target.value)
                            }}
                            placeholder="0"
                            step="1"
                            type="number"
                            value={trimInput}
                          />
                          <FieldDescription>
                            {audioBuffer && trimIsValid
                              ? `First section starts at ${formatMilliseconds(trimValue)}.`
                              : "Offset the first generated section from the start of the track."}
                          </FieldDescription>
                        </Field>
                      </FieldGroup>

                      <p className="text-xs text-muted-foreground">
                        {sections.length > 0
                          ? `${sections.length} playable sections are currently available on the timeline.`
                          : "The timeline will populate once the BPM and trim produce full 16-beat sections."}
                      </p>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <input
              accept="audio/*"
              className="sr-only"
              onChange={handleInputFileChange}
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
                <CardTitle>Timeline</CardTitle>
                <CardDescription>
                  Trimmed intro stays visible, but only exact 16-beat sections are clickable.
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
              <AudioWaveform
                activeSectionId={activeSectionId}
                activeSectionProgress={activeSectionProgress}
                disabled={isDecoding || !audioBuffer}
                durationSec={durationSec}
                emptyMessage={waveformMessage}
                onSectionSelect={handleSectionSelect}
                peaks={waveformPeaks}
                pendingSectionId={pendingSectionId}
                sections={sections}
                trimSec={trimIsValid ? trimValue / 1000 : null}
                viewMode={timelineViewMode}
              />
              <div className="flex justify-center pt-2">
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
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    </>
  )
}
