import assert from "node:assert/strict";
import test from "node:test";

import { compileDsl } from "./index.ts";

test("compileDsl returns normalized compiled metadata", () => {
  const result = compileDsl("main: 1 2+", {
    bpm: 120,
    beatsPerSection: 16,
    trimMs: 250,
    sectionCount: 4,
    sourceId: "boss-theme.mp3",
  });

  assert.ok(result.compiled);
  assert.deepEqual(result.compiled.metadata, {
    bpm: 120,
    beatsPerSection: 16,
    trimMs: 250,
    sectionCount: 4,
    sourceId: "boss-theme.mp3",
    file: "boss-theme.mp3",
  });
});

test("compileDsl keeps diagnostics non-throwing when authoring issues are present", () => {
  const result = compileDsl("main: 9", {
    bpm: 120,
    sectionCount: 4,
  });

  assert.equal(result.compiled, null);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("out of range"),
    ),
  );
});
