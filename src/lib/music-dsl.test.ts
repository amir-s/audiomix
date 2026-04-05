import assert from "node:assert/strict";
import test from "node:test";

import {
  compileMusicDsl,
  connectMusicDslInstructions,
  createFreshMusicDslLabel,
  createNavigator,
  getInstructionIdentity,
  hasMusicDslErrors,
  toggleMusicDslInstructionFade,
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

function createMetadata(sectionCount = 16) {
  return {
    file: "track.mp3",
    bpm: 120,
    beatsPerSection: 16,
    sectionCount,
  };
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

test("expands counted section repetition into sequential instructions", () => {
  const program = compileProgram("main: 1*10");

  assert.equal(program.states.main.instructions.length, 10);
  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      loopTo: instruction.loopTo,
    })),
    Array.from({ length: 10 }, () => ({ section: 1, loopTo: null })),
  );
  assert.equal(program.states.main.exhausts, true);
});

test("expands counted groups in place", () => {
  const program = compileProgram("main: 1 (2 3)*3");

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => instruction.section),
    [1, 2, 3, 2, 3, 2, 3],
  );
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
    currentInstructionIndex: 0,
    nextStateName: "intro",
    nextSection: 2,
    nextInstructionIndex: 1,
    pendingTargetStateName: "main",
    nextComesFromPendingTransition: false,
  });

  navigator.tick();
  assert.equal(navigator.current(), 2);
  assert.equal(navigator.next(), 3);
  assert.equal(navigator.getStatus().nextComesFromPendingTransition, true);
  assert.equal(navigator.getStatus().currentInstructionIndex, 1);
  assert.equal(navigator.getStatus().nextInstructionIndex, 0);

  navigator.tick();
  assert.deepEqual(navigator.getStatus(), {
    currentStateName: "main",
    currentSection: 3,
    currentInstructionIndex: 0,
    nextStateName: "main",
    nextSection: 4,
    nextInstructionIndex: 1,
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

test("transitions can resolve from counted copies that carry exit labels", () => {
  const program = compileProgram(`
main: {a}1{b}*3 2+
target: {b}3+
`);
  const navigator = createNavigator(program);

  navigator.start("main");
  navigator.tick();

  assert.equal(navigator.current(), 1);
  assert.equal(navigator.getStatus().currentInstructionIndex, 1);

  navigator.goTo("target");

  assert.equal(navigator.next(), 3);
  assert.equal(navigator.getStatus().nextComesFromPendingTransition, true);

  navigator.tick();

  assert.equal(navigator.current(), 3);
  assert.equal(navigator.getStatus().currentStateName, "target");
});

test("compiles section crossfade modifiers with labels and repeats", () => {
  const program = compileProgram(`
main: 1 2! !3 !4! 5!{a}+ {b}!6 {c}!7!{d}+
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      entryLabel: instruction.entryLabel,
      exitLabel: instruction.exitLabel,
      loopTo: instruction.loopTo,
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })),
    [
      {
        section: 1,
        entryLabel: null,
        exitLabel: null,
        loopTo: null,
        fadeIn: false,
        fadeOut: false,
      },
      {
        section: 2,
        entryLabel: null,
        exitLabel: null,
        loopTo: null,
        fadeIn: false,
        fadeOut: true,
      },
      {
        section: 3,
        entryLabel: null,
        exitLabel: null,
        loopTo: null,
        fadeIn: true,
        fadeOut: false,
      },
      {
        section: 4,
        entryLabel: null,
        exitLabel: null,
        loopTo: null,
        fadeIn: true,
        fadeOut: true,
      },
      {
        section: 5,
        entryLabel: null,
        exitLabel: "a",
        loopTo: 4,
        fadeIn: false,
        fadeOut: true,
      },
      {
        section: 6,
        entryLabel: "b",
        exitLabel: null,
        loopTo: null,
        fadeIn: true,
        fadeOut: false,
      },
      {
        section: 7,
        entryLabel: "c",
        exitLabel: "d",
        loopTo: 6,
        fadeIn: true,
        fadeOut: true,
      },
    ],
  );
});

test("expands counted section modifiers onto every generated copy", () => {
  const program = compileProgram(`
main: !1!*3
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })),
    [
      { section: 1, fadeIn: true, fadeOut: true },
      { section: 1, fadeIn: true, fadeOut: true },
      { section: 1, fadeIn: true, fadeOut: true },
    ],
  );
});

test("keeps counted entry labels on the first copy and exit labels on every copy", () => {
  const program = compileProgram(`
main: {a}1{b}*3
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      entryLabel: instruction.entryLabel,
      exitLabel: instruction.exitLabel,
    })),
    [
      { section: 1, entryLabel: "a", exitLabel: "b" },
      { section: 1, entryLabel: null, exitLabel: "b" },
      { section: 1, entryLabel: null, exitLabel: "b" },
    ],
  );
  assert.deepEqual(program.states.main.entryPoints, { a: 0 });
});

test("expands group crossfade modifiers onto descendant sections", () => {
  const program = compileProgram(`
main: !(1 2 3)!+
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      loopTo: instruction.loopTo,
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })),
    [
      { section: 1, loopTo: null, fadeIn: true, fadeOut: true },
      { section: 2, loopTo: null, fadeIn: true, fadeOut: true },
      { section: 3, loopTo: 0, fadeIn: true, fadeOut: true },
    ],
  );
});

test("merges nested group and section crossfade modifiers", () => {
  const program = compileProgram(`
main: !(1 (2! 3))!+
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      loopTo: instruction.loopTo,
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })),
    [
      { section: 1, loopTo: null, fadeIn: true, fadeOut: true },
      { section: 2, loopTo: null, fadeIn: true, fadeOut: true },
      { section: 3, loopTo: 0, fadeIn: true, fadeOut: true },
    ],
  );
});

test("navigator status exposes instruction indexes for repeated sections", () => {
  const program = compileProgram(`
loop: 1 2 1 3+
`);
  const navigator = createNavigator(program);

  navigator.start("loop");
  assert.deepEqual(navigator.getStatus(), {
    currentStateName: "loop",
    currentSection: 1,
    currentInstructionIndex: 0,
    nextStateName: "loop",
    nextSection: 2,
    nextInstructionIndex: 1,
    pendingTargetStateName: null,
    nextComesFromPendingTransition: false,
  });

  navigator.tick();
  assert.equal(navigator.getStatus().currentInstructionIndex, 1);
  assert.equal(navigator.getStatus().nextInstructionIndex, 2);

  navigator.tick();
  assert.equal(navigator.current(), 1);
  assert.equal(navigator.getStatus().currentInstructionIndex, 2);
});

test("navigator can start from an arbitrary instruction index", () => {
  const program = compileProgram(`
loop: 1 2 3+
`);
  const navigator = createNavigator(program);

  navigator.start("loop", 1);

  assert.deepEqual(navigator.getStatus(), {
    currentStateName: "loop",
    currentSection: 2,
    currentInstructionIndex: 1,
    nextStateName: "loop",
    nextSection: 3,
    nextInstructionIndex: 2,
    pendingTargetStateName: null,
    nextComesFromPendingTransition: false,
  });

  navigator.tick();
  assert.equal(navigator.current(), 3);
  assert.equal(navigator.getStatus().currentInstructionIndex, 2);

  navigator.tick();
  assert.equal(navigator.current(), 3);
  assert.equal(navigator.getStatus().currentInstructionIndex, 2);
});

test("navigator rejects out-of-range start instruction indexes", () => {
  const program = compileProgram("loop: 1 2 3+");
  const navigator = createNavigator(program);

  assert.throws(() => {
    navigator.start("loop", 3);
  }, /out of range/);
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

test("rejects invalid counted repetition syntax", () => {
  const result = compileMusicDsl(
    `
zero: 1*0
missing: 1*
doubleA: 1*3+
doubleB: 1+*3
`,
    {
      file: "track.mp3",
      bpm: 120,
      sectionCount: 8,
    },
  );

  assert.equal(result.program, null);
  assert.equal(hasMusicDslErrors(result.diagnostics), true);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("positive integer"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("positive repeat count"),
    ),
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("cannot be combined"),
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

test("tracks stable source identities for compiled instructions", () => {
  const program = compileProgram(`
main: {a}1{b}*3 (2 3)+
`);

  assert.deepEqual(
    program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      sourceElementKey: instruction.sourceElementKey,
      sourceOccurrenceIndex: instruction.sourceOccurrenceIndex,
    })),
    [
      { section: 1, sourceElementKey: "0", sourceOccurrenceIndex: 0 },
      { section: 1, sourceElementKey: "0", sourceOccurrenceIndex: 1 },
      { section: 1, sourceElementKey: "0", sourceOccurrenceIndex: 2 },
      { section: 2, sourceElementKey: "1.0", sourceOccurrenceIndex: 0 },
      { section: 3, sourceElementKey: "1.1", sourceOccurrenceIndex: 0 },
    ],
  );
});

test("toggles fade flags on a plain visualized section", () => {
  const dsl = "main: 1 2";
  const program = compileProgram(dsl);
  const target = getInstructionIdentity("main", program.states.main.instructions[1]!);
  const editResult = toggleMusicDslInstructionFade({
    dsl,
    metadata: createMetadata(),
    program,
    target,
    field: "fadeOut",
  });

  assert.equal(editResult.dsl, "main: 1 2!");
  assert.ok(editResult.compileResult.program);
  assert.equal(
    editResult.compileResult.program.states.main.instructions[1]!.fadeOut,
    true,
  );
});

test("materializes inherited fades before toggling an individual visualized section", () => {
  const dsl = "main: !(1 2 3)!+";
  const program = compileProgram(dsl);
  const target = getInstructionIdentity("main", program.states.main.instructions[1]!);
  const editResult = toggleMusicDslInstructionFade({
    dsl,
    metadata: createMetadata(),
    program,
    target,
    field: "fadeIn",
  });

  assert.equal(editResult.dsl, "main: (!1! 2! !3!)+");
  assert.ok(editResult.compileResult.program);
  assert.deepEqual(
    editResult.compileResult.program.states.main.instructions.map((instruction) => ({
      section: instruction.section,
      fadeIn: instruction.fadeIn,
      fadeOut: instruction.fadeOut,
    })),
    [
      { section: 1, fadeIn: true, fadeOut: true },
      { section: 2, fadeIn: false, fadeOut: true },
      { section: 3, fadeIn: true, fadeOut: true },
    ],
  );
});

test("toggles repeated-source fades on every generated copy", () => {
  const dsl = "main: 1*3";
  const program = compileProgram(dsl);
  const target = getInstructionIdentity("main", program.states.main.instructions[1]!);
  const editResult = toggleMusicDslInstructionFade({
    dsl,
    metadata: createMetadata(),
    program,
    target,
    field: "fadeIn",
  });

  assert.equal(editResult.dsl, "main: !1*3");
  assert.ok(editResult.compileResult.program);
  assert.deepEqual(
    editResult.compileResult.program.states.main.instructions.map((instruction) => ({
      fadeIn: instruction.fadeIn,
      sourceOccurrenceIndex: instruction.sourceOccurrenceIndex,
    })),
    [
      { fadeIn: true, sourceOccurrenceIndex: 0 },
      { fadeIn: true, sourceOccurrenceIndex: 1 },
      { fadeIn: true, sourceOccurrenceIndex: 2 },
    ],
  );
});

test("creates fresh labels from unused single letters before falling back to two letters", () => {
  assert.equal(createFreshMusicDslLabel(new Set(["a"]), () => 0), "b");
  assert.equal(
    createFreshMusicDslLabel(
      new Set("abcdefghijklmnopqrstuvwxyz".split("")),
      () => 0,
    ),
    "aa",
  );
});

test("connects a source-only labeled node into an unlabeled target when no entry conflict exists", () => {
  const dsl = `
source: 1{a}
target: 2+
`;
  const program = compileProgram(dsl);
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[0]!),
    target: getInstructionIdentity("target", program.states.target.instructions[0]!),
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{a}\ntarget: {a}2+");
  assert.ok(editResult.compileResult.program);
  assert.equal(
    editResult.compileResult.program.states.target.instructions[0]!.entryLabel,
    "a",
  );
});

test("reuses the target label when the source is unlabeled", () => {
  const dsl = `
source: 1
target: {b}2+
`;
  const program = compileProgram(dsl);
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[0]!),
    target: getInstructionIdentity("target", program.states.target.instructions[0]!),
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{b}\ntarget: {b}2+");
});

test("lets the target label win when both nodes already have different labels", () => {
  const dsl = `
source: 1{x}
target: {y}2+
`;
  const program = compileProgram(dsl);
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[0]!),
    target: getInstructionIdentity("target", program.states.target.instructions[0]!),
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{y}\ntarget: {y}2+");
});

test("creates a fresh label when reusing the source label would duplicate a target entry", () => {
  const dsl = `
source: 1{a}
target: {a}2 3+
`;
  const program = compileProgram(dsl);
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[0]!),
    target: getInstructionIdentity("target", program.states.target.instructions[1]!),
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{b}\ntarget: {a}2 {b}3+");
  assert.ok(editResult.compileResult.program);
  assert.deepEqual(editResult.compileResult.program.states.target.entryPoints, {
    a: 0,
    b: 1,
  });
});

test("connecting into a later repeated target copy resolves to the first generated copy", () => {
  const dsl = `
source: 1
target: 2*3
`;
  const program = compileProgram(dsl);
  const laterRepeatedTarget = getInstructionIdentity(
    "target",
    program.states.target.instructions[2]!,
  );
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[0]!),
    target: laterRepeatedTarget,
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{a}\ntarget: {a}2*3");
  assert.ok(editResult.compileResult.program);
  assert.deepEqual(
    editResult.compileResult.program.states.target.instructions.map((instruction) => ({
      entryLabel: instruction.entryLabel,
      sourceOccurrenceIndex: instruction.sourceOccurrenceIndex,
    })),
    [
      { entryLabel: "a", sourceOccurrenceIndex: 0 },
      { entryLabel: null, sourceOccurrenceIndex: 1 },
      { entryLabel: null, sourceOccurrenceIndex: 2 },
    ],
  );
});

test("connecting from a repeated source updates every generated exit copy", () => {
  const dsl = `
source: 1*3
target: 2+
`;
  const program = compileProgram(dsl);
  const editResult = connectMusicDslInstructions({
    dsl,
    metadata: createMetadata(),
    program,
    source: getInstructionIdentity("source", program.states.source.instructions[1]!),
    target: getInstructionIdentity("target", program.states.target.instructions[0]!),
    random: () => 0,
  });

  assert.equal(editResult.dsl.trim(), "source: 1{a}*3\ntarget: {a}2+");
  assert.ok(editResult.compileResult.program);
  assert.deepEqual(
    editResult.compileResult.program.states.source.instructions.map((instruction) => ({
      exitLabel: instruction.exitLabel,
      sourceOccurrenceIndex: instruction.sourceOccurrenceIndex,
    })),
    [
      { exitLabel: "a", sourceOccurrenceIndex: 0 },
      { exitLabel: "a", sourceOccurrenceIndex: 1 },
      { exitLabel: "a", sourceOccurrenceIndex: 2 },
    ],
  );
});
