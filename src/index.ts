import {
  compileMusicDsl,
  type CompiledMusicProgram,
  type MusicDslDiagnostic,
  type SheetMetadata,
} from "./lib/music-dsl.ts";

export {
  createMixPlayer,
  type MixPlayer,
  type MixPlayerConfig,
  type MixPlayerEvent,
  type MixPlayerListener,
  type MixPlayerPlayOptions,
  type MixPlayerStatus,
  type MixPlayerTransportState,
} from "./lib/mix-player.ts";

export type MixDiagnostic = MusicDslDiagnostic;

export type MixCompileConfig = {
  bpm: number;
  beatsPerSection?: number;
  trimMs?: number;
  sectionCount: number;
  sourceId?: string;
};

export type MixMetadata = {
  bpm: number;
  beatsPerSection: number;
  trimMs: number;
  sectionCount: number;
  sourceId?: string;
  file: string;
};

export type CompiledMix = Omit<CompiledMusicProgram, "metadata"> & {
  metadata: MixMetadata;
};

export type CompileResult = {
  compiled: CompiledMix | null;
  diagnostics: MixDiagnostic[];
};

function normalizeCompileConfig(config: MixCompileConfig): SheetMetadata {
  return {
    file: config.sourceId ?? "mixaudio-source",
    bpm: config.bpm,
    beatsPerSection:
      Number.isFinite(config.beatsPerSection) && (config.beatsPerSection ?? 0) > 0
        ? config.beatsPerSection
        : 16,
    trimMs:
      Number.isFinite(config.trimMs) && (config.trimMs ?? 0) >= 0
        ? config.trimMs
        : 0,
    sectionCount: Math.max(0, Math.floor(config.sectionCount)),
    sourceId: config.sourceId,
  };
}

export function compileDsl(
  dsl: string,
  config: MixCompileConfig,
): CompileResult {
  const metadata = normalizeCompileConfig(config);
  const result = compileMusicDsl(dsl, metadata);

  return {
    compiled: result.program as CompiledMix | null,
    diagnostics: result.diagnostics,
  };
}
