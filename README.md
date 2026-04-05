# mixaudio

`mixaudio` is a browser-first adaptive music library for games. It ships:

- `compileDsl(...)` to compile the music DSL into a normalized runtime graph
- `createMixPlayer(...)` to decode audio and drive playback with `play`, `pause`, `resume`, `stop`, and `goto`
- `npx mixaudio studio` to launch the packaged web studio for authoring and testing mixes

## Install

```bash
npm install mixaudio
```

## Library Usage

```ts
import { compileDsl, createMixPlayer } from "mixaudio";

const compileResult = compileDsl(dsl, {
  bpm: 120,
  beatsPerSection: 16,
  trimMs: 0,
  sectionCount: 8,
  sourceId: "battle-theme.mp3",
});

if (!compileResult.compiled) {
  console.error(compileResult.diagnostics);
  throw new Error("Invalid mix DSL");
}

const player = await createMixPlayer(file, {}, compileResult.compiled);

await player.play({ stateName: "calm" });
player.goto("combat");
```

## Studio

```bash
npx mixaudio studio
```

Options:

- `--port <port>`
- `--host <host>`
- `--no-open`

## Development

```bash
npm run dev
npm run build
npm test
```
