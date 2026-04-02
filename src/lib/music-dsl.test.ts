import assert from "node:assert/strict";
import test from "node:test";

import {
  compileMusicDsl,
  createNavigator,
  hasMusicDslErrors,
  type CompiledMusicProgram,
} from "./music-dsl.ts";

function compileProgram(dsl: string, sectionCount = 16): CompiledMusicProgram {
  const result = compileMusicDsl(dsl, {
    file: "track.mp3",
    bpm: 120,
    beatsPerSection: 16,
    sectionCount,
  });

  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );

  assert.equal(errors.length, 0, JSON.stringify(result.diagnostics, null, 2));
  assert.ok(result.program, "Expected the DSL to compile successfully.");

  return result.program;
}

test("compiles straight-line states into sequential instructions", () => {
  const result = compileMusicDsl("calm: 1 2 3", {
    file: "track.mp3",
    bpm: 120,
    sectionCount: 8,
  });

  assert.ok(result.program);
  assert.equal(hasMusicDslErrors(result.diagnostics), false);
  assert.deepEqual(
    result.program.states.calm.instructions.map((instruction) => ({
      section: instruction.section,
      loopTo: instruction.loopTo,
    })),
    [
      { section: 1, loopTo: null },
      { section: 2, loopTo: null },
      { section: 3, loopTo: null },
    ],
  );
  assert.equal(result.program.states.calm.exhausts, true);
});

test("flattens nested groups and applies loop-back pointers to repeated groups", () => {
  const result = compileMusicDsl("main: (1 (2 3) 4)+", {
    file: "track.mp3",
    bpm: 120,
    sectionCount: 8,
  });

  assert.ok(result.program);
  assert.equal(hasMusicDslErrors(result.diagnostics), false);
  assert.deepEqual(
    result.program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      loopTo: instruction.loopTo,
    })),
    [
      { section: 1, loopTo: null },
      { section: 2, loopTo: null },
      { section: 3, loopTo: null },
      { section: 4, loopTo: 0 },
    ],
  );
  assert.equal(result.program.states.main.exhausts, false);
});

test("buffers transitions until the current section can resolve them", () => {
  const program = compileProgram(`
intro: 1 2{a}
main: {a}3 4+
`);
  const navigator = createNavigator(program);

  navigator.start("intro");
  assert.equal(navigator.current(), 1);
  assert.equal(navigator.next(), 2);

  navigator.goTo("main");
  assert.deepEqual(navigator.getStatus(), {
    currentStateName: "intro",
    currentSection: 1,
    nextStateName: "intro",
    nextSection: 2,
    pendingTargetStateName: "main",
    nextComesFromPendingTransition: false,
  });

  navigator.tick();
  assert.equal(navigator.current(), 2);
  assert.equal(navigator.next(), 3);
  assert.equal(navigator.getStatus().nextComesFromPendingTransition, true);

  navigator.tick();
  assert.deepEqual(navigator.getStatus(), {
    currentStateName: "main",
    currentSection: 3,
    nextStateName: "main",
    nextSection: 4,
    pendingTargetStateName: null,
    nextComesFromPendingTransition: false,
  });
});

test("falls back to state start when the target state has no entry labels", () => {
  const program = compileProgram(`
calm: 1{a} 2+
plain: 3 4+
`);
  const navigator = createNavigator(program);

  navigator.start("calm");
  navigator.goTo("plain");

  assert.equal(navigator.next(), 3);

  navigator.tick();
  assert.equal(navigator.current(), 3);
  assert.equal(navigator.getStatus().currentStateName, "plain");
});

test("the latest goTo call wins before a transition resolves", () => {
  const program = compileProgram(`
calm: 1{a} 2+
alpha: {a}3+
beta: {a}4+
`);
  const navigator = createNavigator(program);

  navigator.start("calm");
  navigator.goTo("alpha");
  navigator.goTo("beta");

  assert.equal(navigator.next(), 4);

  navigator.tick();
  assert.equal(navigator.current(), 4);
  assert.equal(navigator.getStatus().currentStateName, "beta");
});

test("exhausting states return null once playback reaches the end", () => {
  const program = compileProgram("ending: 1 2 3");
  const navigator = createNavigator(program);

  navigator.start("ending");
  assert.equal(navigator.current(), 1);
  assert.equal(navigator.next(), 2);

  navigator.tick();
  assert.equal(navigator.current(), 2);
  assert.equal(navigator.next(), 3);

  navigator.tick();
  assert.equal(navigator.current(), 3);
  assert.equal(navigator.next(), null);

  navigator.tick();
  assert.equal(navigator.current(), null);
  assert.equal(navigator.next(), null);
  assert.equal(navigator.getStatus().currentStateName, null);
});

test("rejects duplicate states and group labels during parsing", () => {
  const result = compileMusicDsl(
    `
dup: {a}1
dup: {a}2
bad: {a}(1 2)
alsoBad: (1 2){b}
`,
    {
      file: "track.mp3",
      bpm: 120,
      sectionCount: 4,
    },
  );

  assert.equal(result.program, null);
  assert.equal(hasMusicDslErrors(result.diagnostics), true);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Duplicate state"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Entry labels on groups are not supported"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Exit labels on groups are not supported"),
    ),
  );
});

test("rejects duplicate entries and out-of-range sections during compilation", () => {
  const result = compileMusicDsl(
    `
range: 9
entries: {a}1 {a}2
`,
    {
      file: "track.mp3",
      bpm: 120,
      sectionCount: 4,
    },
  );

  assert.equal(result.program, null);
  assert.equal(hasMusicDslErrors(result.diagnostics), true);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("out of range"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Duplicate entry label"),
    ),
  );
});

test("emits warnings for unmatched exit labels and exhausting states", () => {
  const result = compileMusicDsl(
    `
intro: 1{x} 2
combat: 3 4
`,
    {
      file: "track.mp3",
      bpm: 120,
      sectionCount: 8,
    },
  );

  assert.ok(result.program);

  const warnings = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  );

  assert.ok(
    warnings.some((diagnostic) =>
      diagnostic.message.includes("does not match any entry label"),
    ),
  );
  assert.ok(
    warnings.some((diagnostic) =>
      diagnostic.message.includes("exhausts instead of looping"),
    ),
  );
});
