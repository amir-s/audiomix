# Music DSL — Design Specification

A domain-specific language for describing adaptive game music using sections of an audio sprite sheet. The DSL defines a state machine where each state describes a musical pattern built from sliced audio sections. A navigator cursor walks through the pattern, and the game can trigger state transitions that are resolved at musically valid boundary points.

## Concepts

### Audio Sections

A single audio file is sliced into equal-length sections based on BPM (beats per minute) and a fixed beat count per section (default: 16 beats). Sections are referenced by 1-based integer indices.

For example, a 120 BPM track with 16 beats per section produces 8-second sections. Section `1` is 0:00–0:08, section `2` is 0:08–0:16, and so on.

### States

Each state is a named musical pattern. A game might have states like `calm`, `combat`, `boss`, or `level1`, `level2`, etc. States are defined one per line in the DSL.

### The Cursor

The navigator maintains a cursor that points to the current position in a state's pattern. The cursor moves forward one section at a time. The audio engine reads the current and next section from the navigator and handles playback and queuing.

### Entry and Exit Labels

Sections can be annotated with **entry labels** (before the section) and **exit labels** (after the section). These labels control how transitions between states work:

- **Exit label**: Declares "if a transition is pending when this section finishes, use this label to find the entry point in the target state."
- **Entry label**: Declares "this is a valid landing point when entering this state with a matching label."

## DSL Syntax

### State Definition

```
stateName: pattern
```

Each line defines a state. The state name is followed by a colon and the pattern.

### Sections

Bare integers reference audio sections by index:

```
calm: 1 2 3
```

This plays section 1, then 2, then 3, once each — then the pattern is exhausted.

### Grouping

Parentheses group sections together:

```
calm: 1 (2 3)
```

Groups are structural — they define a unit that repetition operators and labels can apply to.

### Repetition

The DSL supports both finite and infinite repetition.

The `*N` suffix means "play this section or group exactly `N` times total":

```
build: 1 (2 3)*3
```

This plays: `1 → 2 → 3 → 2 → 3 → 2 → 3`

The `+` operator means "loop this section or group forever":

```
calm: 1 (2 3)+
```

This plays section 1 once, then loops sections 2 and 3 indefinitely: `1 → 2 → 3 → 2 → 3 → 2 → 3 → ...`

`+` can be applied to a single section:

```
ambient: 1+
```

This loops section 1 forever: `1 → 1 → 1 → ...`

Repetition modes:
- **Bare** (no operator): play exactly once.
- **`*N`**: play exactly `N` total times, where `N` is a positive integer.
- **`+`**: loop forever.

Counted repetition stays in the same modifier slot as `+`, so examples like `!1!*3` and `1{a}*3` are valid. For counted sections, the entry label is attached only to the first generated copy, while the exit label is attached to every generated copy.

### Entry Labels

An entry label is written before a section using curly braces:

```
combat: {a}4 ({b}5 6)+
```

Section `4` is the entry point for label `{a}`. Section `5` is the entry point for label `{b}`.

### Exit Labels

An exit label is written after a section using curly braces:

```
calm: 1{a} (2{b} 3{a})+
```

Section `1` has exit label `{a}`. Section `2` has exit label `{b}`. Section `3` has exit label `{a}`.

### Combined Entry and Exit Labels

A section can have both:

```
{a}5{b}
```

Section `5` is an entry point for `{a}` and has exit label `{b}`.

### Full Example

```
calm:    1{a} ({b}2{a} {a}3{b})+
combat:  {a}4 ({b}5{a} {a}6{b})+
boss:    {a}7 8 (9 10)+
```

## Sheet Metadata

The DSL is paired with metadata describing the audio source:

```json
{
  "file": "soundtrack.mp3",
  "bpm": 120,
  "beatsPerSection": 16
}
```

- **file**: Path to the audio file.
- **bpm**: Beats per minute. Used to calculate section duration.
- **beatsPerSection**: Number of beats per section (default: 16).

Section duration is calculated as: `(beatsPerSection / bpm) * 60` seconds.

## How the Cursor Works

The navigator is a cursor that walks through a flat sequence of instructions derived from the DSL pattern.

### Internal Representation

The parser compiles each state's pattern into a list of instruction nodes:

```
combat: {a}4 ({b}5{a} {a}6{b})+
```

Compiles to:

| Position | Section | Entry Label | Exit Label | Loop Back To |
|----------|---------|-------------|------------|--------------|
| 0        | 4       | `a`         | —          | —            |
| 1        | 5       | `b`         | `a`        | —            |
| 2        | 6       | `a`         | `b`        | → 1          |

The "Loop Back To" field is set on the last node of a `+` group, pointing back to the first node of that group.

Counted repetition is compiled away before runtime. For example, `1*3` compiles to three sequential instruction rows for section `1`, while `1+` compiles to a single instruction row whose loop pointer targets itself.

### Cursor Movement

On each `tick()`:

1. The current section becomes the one at the cursor position.
2. The cursor advances:
   - If the current node has a "Loop Back To" pointer, the cursor jumps to that position.
   - Otherwise, the cursor moves to the next position.
3. The next section is read from the new cursor position.

### Walkthrough: `combat: {a}4 ({b}5{a} {a}6{b})+`

```
tick 1: cursor=0 → current=4, next=5
tick 2: cursor=1 → current=5, next=6
tick 3: cursor=2 → current=6, loop back → next=5
tick 4: cursor=1 → current=5, next=6
tick 5: cursor=2 → current=6, loop back → next=5
...
```

## State Transitions

### goTo(stateName)

When the game calls `goTo("combat")`, the navigator buffers the transition request. It does **not** take effect immediately.

### Transition Resolution

At each `tick()`, before advancing the cursor, the navigator checks:

1. Is there a pending `goTo`?
2. Does the **current** section have an exit label?

If both are true, the navigator:

1. Reads the exit label from the current section.
2. Looks up the matching entry label in the target state.
3. Moves the cursor to that entry point in the target state.
4. Clears the pending `goTo`.

If the current section has **no exit label**, the `goTo` remains buffered. The transition will resolve at the next section that does have an exit label.

### Entry Point Resolution

When transitioning to a target state:

- If the exit label matches an entry label in the target state → cursor starts at that entry point.
- If the target state has **no entry labels at all** → cursor starts at position 0 (the beginning).
- If the exit label has **no match** in the target state → this is a DSL authoring error. The parser should warn about unresolvable transitions.

### Transition Always Restarts

Entering a state always starts fresh from the resolved entry point. There is no "resume from where you left off" behavior. If you leave `combat` and come back later, the pattern plays from the entry point again.

### Walkthrough: Transition from `calm` to `combat`

```
calm:    1{a} ({b}2{a} {a}3{b})+
combat:  {a}4 ({b}5{a} {a}6{b})+
```

Navigator is in `calm`, looping through sections 2 and 3:

```
tick: current=2 (exit {a}), next=3
tick: current=3 (exit {b}), next=2
tick: current=2 (exit {a}), next=3
```

Game calls `goTo("combat")` while section 2 is current.

```
tick: current=2 (exit {a}) — pending goTo("combat")
      exit label {a} matches entry {a} in combat → section 4
      transition fires!
tick: cursor is now in combat at position 0
      current=4, next=5
tick: current=5, next=6
tick: current=6, loop back, next=5
...
```

If instead `goTo("combat")` was called while section 3 is current:

```
tick: current=3 (exit {b}) — pending goTo("combat")
      exit label {b} matches entry {b} in combat → section 5
      transition fires!
tick: cursor is now in combat at position 1
      current=5, next=6
tick: current=6, loop back, next=5
...
```

### Walkthrough: Buffered Transition (No Exit Label)

```
intro:  1 2 3{a}
main:   {a}4 (5 6)+
```

Game calls `goTo("main")` while section 1 is current.

```
tick: current=1 (no exit label) — goTo buffered
tick: current=2 (no exit label) — goTo still buffered
tick: current=3 (exit {a}) — pending goTo("main")
      exit label {a} matches entry {a} in main → section 4
      transition fires!
tick: cursor is now in main at position 0
      current=4, next=5
...
```

## Multiple Entry Points and Loop Bodies

A state can have multiple entry points that lead to different loop bodies:

```
level5: {a}1 2 (3 4)+ {b}5 (6 7)+
```

Internal representation:

| Position | Section | Entry Label | Exit Label | Loop Back To |
|----------|---------|-------------|------------|--------------|
| 0        | 1       | `a`         | —          | —            |
| 1        | 2       | —           | —          | —            |
| 2        | 3       | —           | —          | —            |
| 3        | 4       | —           | —          | → 2          |
| 4        | 5       | `b`         | —          | —            |
| 5        | 6       | —           | —          | —            |
| 6        | 7       | —           | —          | → 5          |

Entering at `{a}` → cursor starts at position 0: `1 → 2 → 3 → 4 → 3 → 4 → ...`

Entering at `{b}` → cursor starts at position 4: `5 → 6 → 7 → 6 → 7 → ...`

The cursor never crosses from one loop into the next during normal playback. The `+` loop traps the cursor in its group forever.

## Navigator API

### `createNavigator(dsl: string, metadata: SheetMetadata): Navigator`

Parses the DSL string and returns a navigator instance.

```typescript
interface SheetMetadata {
  file: string
  bpm: number
  beatsPerSection?: number // default: 16
}

interface Navigator {
  start(stateName: string): void
  current(): number | null
  next(): number | null
  tick(): void
  goTo(stateName: string): void
}
```

### `navigator.start(stateName)`

Initializes the cursor at the beginning of the specified state (position 0). This is used to begin playback for the first time.

```typescript
navigator.start("calm")
navigator.current() // → 1
navigator.next()    // → 2
```

### `navigator.current()`

Returns the section index at the current cursor position, or `null` if the navigator hasn't been started.

### `navigator.next()`

Returns the section index at the next cursor position (what will become current after the next `tick()`). Accounts for loop-back pointers and pending `goTo` transitions.

If there is a pending `goTo` and the current section has a valid exit label, `next()` returns the entry section of the target state.

### `navigator.tick()`

Advances the cursor by one step:

1. If there is a pending `goTo` and the current section has a matching exit label → transition to the target state's entry point.
2. Otherwise, if the current node has a loop-back pointer → jump to the loop-back position.
3. Otherwise → move to the next position.

After `tick()`, `current()` returns the new current section and `next()` returns the new predicted next section.

### `navigator.goTo(stateName)`

Buffers a transition to the specified state. Does not change `current()`. May change `next()` if the current section has a valid exit label for the target state.

If `goTo` is called multiple times before a transition resolves, the latest call wins.

```typescript
navigator.goTo("combat")
// current() unchanged
// next() may change if current section has a matching exit label
```

## Integration with Audio Engine

The navigator is consumed by the audio engine in a simple loop:

```typescript
const nav = createNavigator(dslString, metadata)
nav.start("calm")

// Audio engine plays nav.current(), queues nav.next()
engine.play(nav.current())
engine.queue(nav.next())

// On each section boundary (callback from audio engine):
function onSectionBoundary() {
  nav.tick()
  engine.queue(nav.next())
}

// Game triggers state change:
function onGameEvent(newState: string) {
  nav.goTo(newState)
  // next() is now updated, re-queue
  engine.queue(nav.next())
}
```

## Parser Grammar

The DSL grammar in pseudo-BNF:

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
repetition  = "+" | "*" count
count       = [1-9][0-9]*
```

## Complete Example

### Metadata

```json
{
  "file": "game-ost.mp3",
  "bpm": 140,
  "beatsPerSection": 16
}
```

### DSL

```
explore:  1{a} ({b}2{a} {a}3{b})+
dungeon:  {a}4{a} ({b}5{a} {a}6{b})+
combat:   {a}7 8 ({b}9{a} {a}10{b})+
victory:  {a}11 12+
```

### Game Integration

```typescript
const nav = createNavigator(dsl, { file: "game-ost.mp3", bpm: 140 })

// Player starts exploring
nav.start("explore")
// Plays: 1 → 2 → 3 → 2 → 3 → ...

// Player enters dungeon
nav.goTo("dungeon")
// If currently on section 2 (exit {a}) → enters dungeon at {a} → section 4
// If currently on section 3 (exit {b}) → enters dungeon at {b} → section 5
// Plays: 4 → 5 → 6 → 5 → 6 → ... (or 5 → 6 → 5 → 6 → ...)

// Enemy appears
nav.goTo("combat")
// Enters combat at matching entry point
// Plays: 7 → 8 → 9 → 10 → 9 → 10 → ...

// Player wins
nav.goTo("victory")
// Enters victory at matching entry point
// Plays: 11 → 12 → 12 → 12 → ...

// Back to exploring
nav.goTo("explore")
// Starts fresh from entry point in explore
```
