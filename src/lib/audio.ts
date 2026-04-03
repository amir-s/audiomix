export type AudioSection = {
  id: string;
  index: number;
  label: string;
  startSec: number;
  endSec: number;
  startMs: number;
  endMs: number;
};

export const CROSSFADE_DURATION_SEC = 0.2;

const EPSILON = 0.0001;

export function getSectionDurationSec(bpm: number, beatsPerSection = 16) {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return null;
  }

  return (beatsPerSection * 60) / bpm;
}

export function createAudioSections({
  bpm,
  trimMs,
  durationSec,
  beatsPerSection = 16,
}: {
  bpm: number;
  trimMs: number;
  durationSec: number;
  beatsPerSection?: number;
}) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return [];
  }

  if (!Number.isFinite(trimMs) || trimMs < 0) {
    return [];
  }

  const sectionDurationSec = getSectionDurationSec(bpm, beatsPerSection);

  if (!sectionDurationSec) {
    return [];
  }

  const startOffsetSec = trimMs / 1000;

  if (startOffsetSec >= durationSec) {
    return [];
  }

  const sections: AudioSection[] = [];
  let cursorSec = startOffsetSec;
  let index = 0;

  while (cursorSec + sectionDurationSec <= durationSec + EPSILON) {
    const startSec = cursorSec;
    const endSec = Math.min(durationSec, cursorSec + sectionDurationSec);

    sections.push({
      id: `section-${index + 1}`,
      index,
      label: `S${String(index + 1).padStart(2, "0")}`,
      startSec,
      endSec,
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
    });

    cursorSec += sectionDurationSec;
    index += 1;
  }

  return sections;
}

export function extractWaveformPeaks(buffer: AudioBuffer, targetPeaks = 1024) {
  if (buffer.length === 0 || buffer.numberOfChannels === 0) {
    return [];
  }

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const sampleWindow = Math.max(1, Math.floor(buffer.length / targetPeaks));
  const peaks: number[] = [];

  for (let peakIndex = 0; peakIndex < targetPeaks; peakIndex += 1) {
    const start = peakIndex * sampleWindow;

    if (start >= buffer.length) {
      break;
    }

    const end = Math.min(buffer.length, start + sampleWindow);
    let maxAmplitude = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let combinedAmplitude = 0;

      for (
        let channelIndex = 0;
        channelIndex < channels.length;
        channelIndex += 1
      ) {
        combinedAmplitude += Math.abs(
          channels[channelIndex]?.[sampleIndex] ?? 0,
        );
      }

      maxAmplitude = Math.max(
        maxAmplitude,
        combinedAmplitude / channels.length,
      );
    }

    peaks.push(maxAmplitude);
  }

  const highestPeak = Math.max(...peaks, 0);

  if (highestPeak === 0) {
    return peaks.map(() => 0.04);
  }

  return peaks.map((peak) => Math.max(0.04, peak / highestPeak));
}

export function formatMilliseconds(totalMs: number) {
  const safeMs = Math.max(0, Math.round(totalMs));
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const milliseconds = safeMs % 1000;

  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function formatDuration(seconds: number) {
  return formatMilliseconds(seconds * 1000);
}
