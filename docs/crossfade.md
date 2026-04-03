# Crossfade (`!`) — Design Specification

Crossfade adds smooth audio transitions between sections using the `!` modifier. Instead of hard-cutting at beat boundaries, sections can overlap briefly with volume ramps, creating seamless transitions.

## Syntax

The `!` character is placed directly adjacent to a section or group:

- **Post-crossfade** (`2!`): Fade out the tail of section 2 after it ends.
- **Pre-crossfade** (`!5`): Fade in the head of section 5 before it starts.
- **Both** (`!5!`): Fade in and fade out on the same section.

### Position in Grammar

The `!` sits between entry/exit labels and the atom:

```
element = entryLabel? "!"? atom "!"? exitLabel? repetition?
```

Full ordering: `[entryLabel] [!] atom [!] [exitLabel] [+]`

Examples:

```
2!          post-crossfade
!5          pre-crossfade
!5!         both
2!+         post-crossfade + repeat
!5+         pre-crossfade + repeat
2!{a}+      post-crossfade + exit label + repeat
{b}!5       entry label + pre-crossfade
{b}!5!{a}+  entry label + pre-in + section + fade-out + exit label + repeat
```

### Groups

When `!` is applied to a group, it expands to all sections within that group:

```
(1 2 3)!    → (1! 2! 3!)
!(1 2 3)    → (!1 !2 !3)
!(1 2 3)!   → (!1! !2! !3!)
!(1 2 3)!+  → (!1! !2! !3!)+
```

The expansion happens at compile time during flattening.

## Behavior

### Post-Crossfade (`2!`)

When section 2 finishes playing at the beat boundary:

1. The next section starts playing at full volume exactly on the beat (unchanged behavior).
2. A **separate audio source** plays the 200ms of audio immediately *after* section 2's end offset in the buffer.
3. This separate source fades out from full volume to zero over the 200ms duration.

The result: the tail of section 2 bleeds into the next section, fading out smoothly.

```
Time:    ... ─────|─────────────── ...
                  ^ beat boundary
Section 2:  ██████|▓▒░             (main stops, tail fades out over 200ms)
Section 5:        |██████████████  (starts at full volume on beat)
```

### Pre-Crossfade (`!5`)

When section 5 is queued to play next:

1. 200ms *before* the beat boundary, a **separate audio source** starts playing the 200ms of audio immediately *before* section 5's start offset in the buffer.
2. This separate source fades in from zero to full volume over the 200ms duration.
3. At the beat boundary, section 5 starts playing at full volume from its normal start offset (unchanged behavior).

The result: the head of section 5 bleeds into the previous section, fading in smoothly.

```
Time:    ... ─────|─────────────── ...
                  ^ beat boundary
Section 2:  ██████|                (plays normally, stops on beat)
Section 5:    ░▒▓█|██████████████  (head fades in 200ms before, main starts on beat)
```

### Combined (`2!` transitioning to `!5`)

When both sides of a transition have crossfade, the effects are independent:

```
Time:    ... ─────|─────────────── ...
                  ^ beat boundary
Section 2:  ██████|▓▒░             (main stops, tail fades out 200ms)
Section 5:    ░▒▓█|██████████████  (head fades in 200ms before, main starts on beat)
```

200ms before the boundary: section 2 at full volume + section 5's head fading in.
At the boundary: section 5 at full volume + section 2's tail fading out.

Three audio sources may briefly overlap in the 200ms window around the boundary.

### Self-Repeat (`2!+`)

When section 2 loops back to itself, the crossfade still applies. The tail of the previous play fades out while the next play starts at full volume. The `!` modifier does not special-case self-transitions.

## Duration

The crossfade duration is **hardcoded at 200ms**. There is no DSL syntax for specifying a custom duration. This is stored as a constant in the codebase.

## Edge Cases

### No Audio Available

If a section is at the boundary of the audio buffer and there isn't 200ms of audio available for the crossfade:

- **Post-crossfade on the last section**: No tail audio exists after the buffer end. The crossfade is silently skipped (no-op).
- **Pre-crossfade on the first section**: No head audio exists before the buffer start. The crossfade is silently skipped (no-op).

In both cases, the main section plays normally with no error or warning.

## Compiled Representation

Two boolean fields are added to `CompiledInstruction`:

```typescript
interface CompiledInstruction {
  position: number;
  section: number;
  entryLabel: string | null;
  exitLabel: string | null;
  loopTo: number | null;
  fadeIn: boolean;   // pre-crossfade (! before section)
  fadeOut: boolean;  // post-crossfade (! after section)
  line: number;
  column: number;
}
```

Group `!` expansion happens during `flattenElements()`. By the time instructions are flattened, each instruction already carries its own `fadeIn`/`fadeOut` flags — no group-level information is needed at runtime.

## Audio Implementation

### Architecture

The crossfade is implemented as an **overlay** on top of the existing playback system. The main section playback remains unchanged — sections still play at full volume with `source.start(startTime, offset, duration)` connected to `audioContext.destination`.

Crossfade adds separate audio sources for the fade tails/heads:

```
Main section:     BufferSource → destination          (existing, unchanged)
Fade-out tail:    BufferSource → GainNode → destination  (new)
Fade-in head:     BufferSource → GainNode → destination  (new)
```

### Fade-Out Tail (Post-Crossfade)

When scheduling a section with `fadeOut: true`:

1. Create a new `BufferSource` from the same `AudioBuffer`.
2. Create a `GainNode`.
3. Connect: `source → gainNode → destination`.
4. Set `gainNode.gain` to `1.0` at the beat boundary time.
5. Schedule `gainNode.gain.linearRampToValueAtTime(0, boundaryTime + 0.2)`.
6. Call `source.start(boundaryTime, sectionEndOffsetSec, 0.2)` — plays 200ms of audio starting from the section's end offset.

### Fade-In Head (Pre-Crossfade)

When scheduling a section with `fadeIn: true`:

1. Create a new `BufferSource` from the same `AudioBuffer`.
2. Create a `GainNode`.
3. Connect: `source → gainNode → destination`.
4. Set `gainNode.gain` to `0.0` at `boundaryTime - 0.2`.
5. Schedule `gainNode.gain.linearRampToValueAtTime(1, boundaryTime)`.
6. Call `source.start(boundaryTime - 0.2, sectionStartOffsetSec - 0.2, 0.2)` — plays 200ms of audio ending at the section's start offset.

### No UI Changes

The crossfade is purely an audio effect. Progress tracking, section highlighting, and all UI behavior remain based on beat boundaries. The crossfade is invisible to the user interface.

## Updated Grammar

```
program     = state+
state       = stateName ":" pattern NEWLINE
stateName   = [a-zA-Z_][a-zA-Z0-9_]*
pattern     = element+
element     = entryLabel? "!"? atom "!"? exitLabel? repetition?
atom        = section | group
group       = "(" element+ ")"
section     = [1-9][0-9]*
entryLabel  = "{" labelName "}"
exitLabel   = "{" labelName "}"
labelName   = [a-zA-Z][a-zA-Z0-9]*
repetition  = "+"
```

## Examples

### Basic Fade-Out

```
l1: 1 2!+
l2: 5 6+
```

Section 2 loops with a fade-out tail on every transition (both looping back to itself and transitioning to level 2).

### Basic Fade-In

```
l1: 1 2+
l2: !5 6+
```

Section 5 fades in when entered from level 1. The 200ms before section 5's start plays as a fade-in over section 2's tail.

### Both Sides

```
l1: 1 2!+
l2: !5 6+
```

Transitioning from 2 to 5: section 2's tail fades out while section 5's head fades in. Maximum smoothness.

### With Entry/Exit Labels

```
l1: 1{b} 2!{a}+
l2: {b}!5 {a}6+
```

Section 2 has post-crossfade and exit label `{a}`. Section 5 has pre-crossfade and entry label `{b}`. Labels and crossfade work independently.

### Group Crossfade

```
l1: !(1 2 3)!+
```

Every section in the group gets both fade-in and fade-out. Every transition within the loop (1→2, 2→3, 3→1) has crossfade on both sides.
