import assert from "node:assert/strict";
import test from "node:test";

import {
  compileDsl,
  createMixPlayer,
  type CompiledMix,
  type MixPlayerEvent,
} from "./index.ts";
import { FakeAudioContext } from "./test/fake-audio.ts";

function compileMix(dsl: string, sectionCount = 4) {
  const result = compileDsl(dsl, {
    bpm: 120,
    beatsPerSection: 16,
    sectionCount,
    sourceId: "track.mp3",
    trimMs: 0,
  });

  assert.ok(result.compiled, "Expected the mix to compile successfully.");

  return result.compiled as CompiledMix;
}

function getPlaybackSources(audioContext: FakeAudioContext) {
  return audioContext.createdSources.filter((source) =>
    source.startCalls.some((call) => (call.duration ?? 0) > 1),
  );
}

function getOverlaySources(audioContext: FakeAudioContext) {
  return audioContext.createdSources.filter((source) =>
    source.startCalls.some((call) => (call.duration ?? 0) <= 1),
  );
}

async function flushAsyncWork() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("createMixPlayer accepts ArrayBuffer, Blob, and File sources", async () => {
  const compiled = compileMix("main: 1 2+");

  for (const source of [
    new ArrayBuffer(8),
    new Blob(["audio-bytes"]),
    new File(["audio-bytes"], "track.mp3", { type: "audio/mpeg" }),
  ]) {
    const audioContext = new FakeAudioContext({
      bufferDurationSec: 32,
      state: "running",
    });
    const player = await createMixPlayer(
      source,
      { audioContext: audioContext as unknown as AudioContext },
      compiled,
    );

    assert.equal(audioContext.decodeCalls.length, 1);
    await player.destroy();
  }
});

test("play starts from the default state and can restart from an explicit state", async () => {
  const audioContext = new FakeAudioContext({
    bufferDurationSec: 32,
    state: "suspended",
  });
  const compiled = compileMix(`
calm: 1{a} 2+
combat: {a}3+
`);
  const player = await createMixPlayer(
    new ArrayBuffer(8),
    { audioContext: audioContext as unknown as AudioContext },
    compiled,
  );

  await player.play();

  assert.equal(audioContext.state, "running");
  assert.deepEqual(player.getStatus(), {
    ...player.getStatus(),
    currentStateName: "calm",
    currentSection: 1,
    currentInstructionIndex: 0,
    nextStateName: "calm",
    nextSection: 2,
    nextInstructionIndex: 1,
    pendingTargetStateName: null,
    nextComesFromPendingTransition: false,
    transportState: "playing",
    isPaused: false,
    currentFadeIn: false,
    currentFadeOut: false,
    nextFadeIn: false,
    nextFadeOut: false,
  });

  await player.play({ stateName: "combat" });

  assert.equal(player.getStatus().currentStateName, "combat");
  assert.equal(player.getStatus().currentSection, 3);

  await player.destroy();
});

test("goto queues the transition and resolves it at the section boundary", async () => {
  const audioContext = new FakeAudioContext({
    bufferDurationSec: 32,
    state: "running",
  });
  const compiled = compileMix(`
calm: 1{a} 2+
combat: {a}3+
`);
  const player = await createMixPlayer(
    new ArrayBuffer(8),
    { audioContext: audioContext as unknown as AudioContext },
    compiled,
  );

  await player.play({ stateName: "calm" });
  player.goto("combat");

  assert.equal(player.getStatus().pendingTargetStateName, "combat");
  assert.equal(player.getStatus().nextStateName, "combat");
  assert.equal(player.getStatus().nextSection, 3);
  assert.equal(player.getStatus().nextComesFromPendingTransition, true);

  audioContext.advanceTime(8);
  getPlaybackSources(audioContext)[0]!.emitEnded();
  await flushAsyncWork();

  assert.equal(player.getStatus().currentStateName, "combat");
  assert.equal(player.getStatus().currentSection, 3);
  assert.equal(player.getStatus().pendingTargetStateName, null);

  await player.destroy();
});

test("pause, resume, stop, subscribe, and destroy update transport state", async () => {
  const events: MixPlayerEvent[] = [];
  const audioContext = new FakeAudioContext({
    bufferDurationSec: 32,
    state: "running",
  });
  const compiled = compileMix("main: 1 2+");
  const player = await createMixPlayer(
    new ArrayBuffer(8),
    { audioContext: audioContext as unknown as AudioContext },
    compiled,
  );
  const unsubscribe = player.subscribe((event) => {
    events.push(event);
  });

  await player.play();
  await player.pause();
  assert.equal(player.getStatus().transportState, "paused");

  await player.resume();
  assert.equal(player.getStatus().transportState, "playing");

  player.stop();
  assert.equal(player.getStatus().transportState, "idle");

  unsubscribe();
  await player.destroy();

  assert.ok(
    events.some(
      (event) =>
        event.type === "status" && event.status.transportState === "playing",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "status" && event.status.transportState === "paused",
    ),
  );
  assert.equal(audioContext.state, "running");
});

test("createMixPlayer rejects audio whose decoded section count does not match", async () => {
  const compiled = compileMix("main: 1 2+", 4);
  const audioContext = new FakeAudioContext({
    bufferDurationSec: 24,
    state: "running",
  });

  await assert.rejects(
    createMixPlayer(
      new ArrayBuffer(8),
      { audioContext: audioContext as unknown as AudioContext },
      compiled,
    ),
    /expects 4/,
  );
});

test("adjacent boundaries suppress runtime crossfade overlay sources", async () => {
  const compiled = compileMix("main: 1! !2+");
  const audioContext = new FakeAudioContext({
    bufferDurationSec: 32,
    state: "running",
  });
  const player = await createMixPlayer(
    new ArrayBuffer(8),
    { audioContext: audioContext as unknown as AudioContext },
    compiled,
  );

  await player.play();

  assert.equal(getOverlaySources(audioContext).length, 0);

  await player.destroy();
});

test("destroy closes an owned audio context", async () => {
  class OwnedAudioContext extends FakeAudioContext {
    static lastInstance: OwnedAudioContext | null = null;

    constructor() {
      super({ bufferDurationSec: 32, state: "running" });
      OwnedAudioContext.lastInstance = this;
    }
  }

  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = OwnedAudioContext as unknown as typeof AudioContext;

  try {
    const player = await createMixPlayer(
      new ArrayBuffer(8),
      {},
      compileMix("main: 1 2+"),
    );

    await player.destroy();

    assert.equal(OwnedAudioContext.lastInstance?.state, "closed");
  } finally {
    globalThis.AudioContext = originalAudioContext;
  }
});
