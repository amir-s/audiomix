export type MusicDslDiagnosticSeverity = "error" | "warning";

export type MusicDslDiagnostic = {
  severity: MusicDslDiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  stateName?: string;
};

export type SheetMetadata = {
  file: string;
  bpm: number;
  beatsPerSection?: number;
  sectionCount: number;
};

export type CompiledInstruction = {
  position: number;
  section: number;
  entryLabel: string | null;
  exitLabel: string | null;
  loopTo: number | null;
  fadeIn: boolean;
  fadeOut: boolean;
  line: number;
  column: number;
};

export type CompiledState = {
  name: string;
  instructions: CompiledInstruction[];
  entryPoints: Record<string, number>;
  hasEntryLabels: boolean;
  exhausts: boolean;
};

export type CompiledMusicProgram = {
  metadata: SheetMetadata;
  stateOrder: string[];
  states: Record<string, CompiledState>;
};

export type MusicDslCompileResult = {
  program: CompiledMusicProgram | null;
  diagnostics: MusicDslDiagnostic[];
};

export type NavigatorStatus = {
  currentStateName: string | null;
  currentSection: number | null;
  currentInstructionIndex: number | null;
  nextStateName: string | null;
  nextSection: number | null;
  nextInstructionIndex: number | null;
  pendingTargetStateName: string | null;
  nextComesFromPendingTransition: boolean;
};

export type Navigator = {
  start(stateName: string): void;
  current(): number | null;
  next(): number | null;
  tick(): void;
  goTo(stateName: string): void;
  getStatus(): NavigatorStatus;
};

type ParsedRepetition =
  | { kind: "once" }
  | { kind: "forever" }
  | { kind: "count"; count: number };

type ParsedSectionElement = {
  kind: "section";
  section: number;
  entryLabel: string | null;
  exitLabel: string | null;
  repetition: ParsedRepetition;
  fadeIn: boolean;
  fadeOut: boolean;
  line: number;
  column: number;
};

type ParsedGroupElement = {
  kind: "group";
  elements: ParsedElement[];
  repetition: ParsedRepetition;
  fadeIn: boolean;
  fadeOut: boolean;
  line: number;
  column: number;
};

type ParsedElement = ParsedSectionElement | ParsedGroupElement;

type ParsedState = {
  name: string;
  elements: ParsedElement[];
  line: number;
  column: number;
};

type ResolveTransitionResult = {
  stateName: string;
  index: number;
  section: number;
} | null;

function compareDiagnostics(
  left: MusicDslDiagnostic,
  right: MusicDslDiagnostic,
) {
  if (left.severity !== right.severity) {
    return left.severity === "error" ? -1 : 1;
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.column - right.column;
}

class LineParser {
  private readonly lineText: string;
  private readonly lineNumber: number;
  private readonly diagnostics: MusicDslDiagnostic[];
  private index = 0;

  constructor(
    lineText: string,
    lineNumber: number,
    diagnostics: MusicDslDiagnostic[],
  ) {
    this.lineText = lineText;
    this.lineNumber = lineNumber;
    this.diagnostics = diagnostics;
  }

  parseState(): ParsedState | null {
    this.skipWhitespace();
    const stateColumn = this.getColumn();
    const stateName = this.parseIdentifier("state name");

    if (!stateName) {
      return null;
    }

    this.skipWhitespace();

    if (!this.consume(":")) {
      this.pushError("Expected ':' after the state name.", this.getColumn());
      return null;
    }

    const elements = this.parseElements({ stopOnRightParen: false });

    this.skipWhitespace();

    if (!this.isAtEnd()) {
      const current = this.peek();
      const message =
        current === ")"
          ? "Unexpected ')'."
          : `Unexpected token '${current}'.`;
      this.pushError(message, this.getColumn());
    }

    if (elements.length === 0) {
      this.pushError(
        "State patterns must contain at least one section or group.",
        Math.max(this.getColumn(), stateColumn),
      );
      return null;
    }

    return {
      name: stateName,
      elements,
      line: this.lineNumber,
      column: stateColumn,
    };
  }

  private parseElements({
    stopOnRightParen,
  }: {
    stopOnRightParen: boolean;
  }) {
    const elements: ParsedElement[] = [];

    while (true) {
      this.skipWhitespace();

      if (this.isAtEnd()) {
        break;
      }

      if (stopOnRightParen && this.peek() === ")") {
        break;
      }

      const element = this.parseElement();

      if (!element) {
        if (this.isAtEnd()) {
          break;
        }

        this.index += 1;
        continue;
      }

      elements.push(element);
    }

    return elements;
  }

  private parseElement(): ParsedElement | null {
    this.skipWhitespace();

    const startColumn = this.getColumn();
    const entryLabel = this.peek() === "{" ? this.parseLabel("entry") : null;

    this.skipWhitespace();
    const fadeInColumn = this.getColumn();
    const fadeIn = this.consume("!");

    this.skipWhitespace();

    if (this.isAtEnd()) {
      if (fadeIn) {
        this.pushError(
          "Crossfade modifiers must be attached to a section or group.",
          fadeInColumn,
        );
      } else if (entryLabel !== null) {
        this.pushError(
          "Entry labels must be attached to a section.",
          startColumn,
        );
      }
      return null;
    }

    const atom = this.parseAtom();

    if (!atom) {
      return null;
    }

    const fadeOut = this.consume("!");
    const exitLabel = this.peek() === "{" ? this.parseLabel("exit") : null;
    const repetition = this.parseRepetition();

    if (atom.kind === "group") {
      if (entryLabel !== null) {
        this.pushError(
          "Entry labels on groups are not supported; attach the label to a section instead.",
          startColumn,
        );
      }

      if (exitLabel !== null) {
        this.pushError(
          "Exit labels on groups are not supported; attach the label to a section instead.",
          atom.column,
        );
      }

      return {
        ...atom,
        fadeIn,
        fadeOut,
        repetition,
      };
    }

    return {
      ...atom,
      entryLabel,
      exitLabel,
      fadeIn,
      fadeOut,
      repetition,
    };
  }

  private parseAtom():
    | Omit<
        ParsedSectionElement,
        "entryLabel" | "exitLabel" | "repetition" | "fadeIn" | "fadeOut"
      >
    | Omit<ParsedGroupElement, "repetition" | "fadeIn" | "fadeOut">
    | null {
    const column = this.getColumn();
    const next = this.peek();

    if (!next) {
      return null;
    }

    if (next === "(") {
      this.index += 1;
      const elements = this.parseElements({ stopOnRightParen: true });

      this.skipWhitespace();

      if (!this.consume(")")) {
        this.pushError("Unmatched '('; expected ')'.", column);
        return null;
      }

      if (elements.length === 0) {
        this.pushError("Groups cannot be empty.", column);
      }

      return {
        kind: "group",
        elements,
        line: this.lineNumber,
        column,
      };
    }

    if (isDigit(next)) {
      const sectionText = this.consumeWhile(isDigit);
      const section = Number.parseInt(sectionText, 10);

      return {
        kind: "section",
        section,
        line: this.lineNumber,
        column,
      };
    }

    if (next === ")") {
      this.pushError("Unexpected ')'.", column);
      return null;
    }

    this.pushError(`Unexpected token '${next}'.`, column);
    return null;
  }

  private parseRepetition(): ParsedRepetition {
    if (this.consume("+")) {
      this.consumeInvalidRepetitionSuffix();
      return { kind: "forever" };
    }

    const starColumn = this.getColumn();

    if (!this.consume("*")) {
      return { kind: "once" };
    }

    const first = this.peek();

    if (!first || !isDigit(first)) {
      this.pushError("Expected a positive repeat count after '*'.", starColumn);
      this.consumeInvalidRepetitionSuffix();
      return { kind: "once" };
    }

    const countText = this.consumeWhile(isDigit);

    if (countText.startsWith("0")) {
      this.pushError(
        "Counted repetition must use a positive integer.",
        starColumn,
      );
      this.consumeInvalidRepetitionSuffix();
      return { kind: "once" };
    }

    this.consumeInvalidRepetitionSuffix();

    return {
      kind: "count",
      count: Number.parseInt(countText, 10),
    };
  }

  private consumeInvalidRepetitionSuffix() {
    const next = this.peek();

    if (next !== "+" && next !== "*") {
      return;
    }

    this.pushError(
      "Repetition modifiers cannot be combined on the same element.",
      this.getColumn(),
    );

    while (!this.isAtEnd()) {
      const value = this.peek();

      if (!value || (value !== "+" && value !== "*" && !isDigit(value))) {
        return;
      }

      this.index += 1;
    }
  }

  private parseIdentifier(context: string) {
    const column = this.getColumn();
    const first = this.peek();

    if (!first || !isIdentifierStart(first)) {
      this.pushError(`Expected ${context}.`, column);
      return null;
    }

    return this.consumeWhile(isIdentifierPart);
  }

  private parseLabel(kind: "entry" | "exit") {
    const column = this.getColumn();
    this.index += 1;

    const first = this.peek();

    if (!first || !isLabelStart(first)) {
      this.pushError(`Expected ${kind} label name after '{'.`, column);
      this.recoverLabel();
      return null;
    }

    const label = this.consumeWhile(isLabelPart);

    if (!this.consume("}")) {
      this.pushError(`Unmatched '{' in ${kind} label.`, column);
      this.recoverLabel();
      return null;
    }

    return label;
  }

  private recoverLabel() {
    while (!this.isAtEnd()) {
      const value = this.peek();

      if (!value) {
        return;
      }

      this.index += 1;

      if (value === "}") {
        return;
      }
    }
  }

  private skipWhitespace() {
    while (!this.isAtEnd() && isWhitespace(this.peek())) {
      this.index += 1;
    }
  }

  private consume(expected: string) {
    if (this.lineText.slice(this.index, this.index + expected.length) !== expected) {
      return false;
    }

    this.index += expected.length;
    return true;
  }

  private consumeWhile(predicate: (value: string) => boolean) {
    const start = this.index;

    while (!this.isAtEnd()) {
      const value = this.peek();

      if (!value || !predicate(value)) {
        break;
      }

      this.index += 1;
    }

    return this.lineText.slice(start, this.index);
  }

  private isAtEnd() {
    return this.index >= this.lineText.length;
  }

  private peek() {
    return this.lineText[this.index] ?? null;
  }

  private getColumn() {
    return this.index + 1;
  }

  private pushError(message: string, column: number) {
    this.diagnostics.push({
      severity: "error",
      message,
      line: this.lineNumber,
      column,
    });
  }
}

function isWhitespace(value: string | null) {
  return value === " " || value === "\t";
}

function isDigit(value: string) {
  return value >= "0" && value <= "9";
}

function isIdentifierStart(value: string) {
  return (
    (value >= "a" && value <= "z") ||
    (value >= "A" && value <= "Z") ||
    value === "_"
  );
}

function isIdentifierPart(value: string) {
  return isIdentifierStart(value) || isDigit(value);
}

function isLabelStart(value: string) {
  return (value >= "a" && value <= "z") || (value >= "A" && value <= "Z");
}

function isLabelPart(value: string) {
  return isLabelStart(value) || isDigit(value);
}

function flattenElements(
  elements: ParsedElement[],
  instructions: CompiledInstruction[],
  diagnostics: MusicDslDiagnostic[],
  stateName: string,
  sectionCount: number,
  inheritedFadeIn = false,
  inheritedFadeOut = false,
  reportDiagnostics = true,
) {
  for (const element of elements) {
    flattenElement(
      element,
      instructions,
      diagnostics,
      stateName,
      sectionCount,
      inheritedFadeIn,
      inheritedFadeOut,
      true,
      reportDiagnostics,
    );
  }
}

function flattenElement(
  element: ParsedElement,
  instructions: CompiledInstruction[],
  diagnostics: MusicDslDiagnostic[],
  stateName: string,
  sectionCount: number,
  inheritedFadeIn: boolean,
  inheritedFadeOut: boolean,
  includeEntryLabel: boolean,
  reportDiagnostics: boolean,
) {
  if (element.repetition.kind === "count") {
    for (let copyIndex = 0; copyIndex < element.repetition.count; copyIndex += 1) {
      flattenElementOnce(
        element,
        instructions,
        diagnostics,
        stateName,
        sectionCount,
        inheritedFadeIn,
        inheritedFadeOut,
        includeEntryLabel && copyIndex === 0,
        reportDiagnostics && copyIndex === 0,
      );
    }
    return;
  }

  flattenElementOnce(
    element,
    instructions,
    diagnostics,
    stateName,
    sectionCount,
    inheritedFadeIn,
    inheritedFadeOut,
    includeEntryLabel,
    reportDiagnostics,
  );
}

function flattenElementOnce(
  element: ParsedElement,
  instructions: CompiledInstruction[],
  diagnostics: MusicDslDiagnostic[],
  stateName: string,
  sectionCount: number,
  inheritedFadeIn: boolean,
  inheritedFadeOut: boolean,
  includeEntryLabel: boolean,
  reportDiagnostics: boolean,
) {
  if (element.kind === "section") {
    if (element.section < 1 || element.section > sectionCount) {
      if (reportDiagnostics) {
        diagnostics.push({
          severity: "error",
          message: `Section ${element.section.toString()} is out of range for this track; expected 1-${Math.max(
            sectionCount,
            0,
          ).toString()}.`,
          line: element.line,
          column: element.column,
          stateName,
        });
      }
      return;
    }

    const position = instructions.length;
    instructions.push({
      position,
      section: element.section,
      entryLabel: includeEntryLabel ? element.entryLabel : null,
      exitLabel: element.exitLabel,
      loopTo: element.repetition.kind === "forever" ? position : null,
      fadeIn: inheritedFadeIn || element.fadeIn,
      fadeOut: inheritedFadeOut || element.fadeOut,
      line: element.line,
      column: element.column,
    });
    return;
  }

  const groupStart = instructions.length;
  flattenElements(
    element.elements,
    instructions,
    diagnostics,
    stateName,
    sectionCount,
    inheritedFadeIn || element.fadeIn,
    inheritedFadeOut || element.fadeOut,
    reportDiagnostics,
  );

  if (
    element.repetition.kind === "forever" &&
    instructions.length > groupStart
  ) {
    instructions[instructions.length - 1]!.loopTo = groupStart;
  }
}

function stateExhausts(instructions: CompiledInstruction[]) {
  let cursor = 0;
  const seen = new Set<number>();

  while (cursor < instructions.length) {
    if (seen.has(cursor)) {
      return false;
    }

    seen.add(cursor);
    const current = instructions[cursor]!;

    if (current.loopTo !== null) {
      cursor = current.loopTo;
      continue;
    }

    cursor += 1;
  }

  return true;
}

function compileParsedState(
  parsedState: ParsedState,
  diagnostics: MusicDslDiagnostic[],
  metadata: SheetMetadata,
): CompiledState | null {
  const instructions: CompiledInstruction[] = [];

  flattenElements(
    parsedState.elements,
    instructions,
    diagnostics,
    parsedState.name,
    metadata.sectionCount,
  );

  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" &&
        diagnostic.stateName === parsedState.name,
    )
  ) {
    return null;
  }

  const entryPoints: Record<string, number> = {};

  for (const instruction of instructions) {
    if (!instruction.entryLabel) {
      continue;
    }

    if (instruction.entryLabel in entryPoints) {
      diagnostics.push({
        severity: "error",
        message: `Duplicate entry label '{${instruction.entryLabel}}' in state '${parsedState.name}'.`,
        line: instruction.line,
        column: instruction.column,
        stateName: parsedState.name,
      });
      return null;
    }

    entryPoints[instruction.entryLabel] = instruction.position;
  }

  const exhausts = stateExhausts(instructions);

  if (exhausts) {
    const lastInstruction = instructions[instructions.length - 1] ?? null;

    diagnostics.push({
      severity: "warning",
      message: `State '${parsedState.name}' exhausts instead of looping.`,
      line: lastInstruction?.line ?? parsedState.line,
      column: lastInstruction?.column ?? parsedState.column,
      stateName: parsedState.name,
    });
  }

  return {
    name: parsedState.name,
    instructions,
    entryPoints,
    hasEntryLabels: Object.keys(entryPoints).length > 0,
    exhausts,
  };
}

function resolveEntryIndex(
  state: CompiledState,
  label: string | null,
) {
  if (!state.hasEntryLabels) {
    return 0;
  }

  if (!label) {
    return null;
  }

  return state.entryPoints[label] ?? null;
}

function getInstructionAt(
  state: CompiledState | null,
  index: number | null,
) {
  if (!state || index === null) {
    return null;
  }

  return state.instructions[index] ?? null;
}

function getNextIndex(state: CompiledState, index: number) {
  const current = state.instructions[index];

  if (!current) {
    return null;
  }

  if (current.loopTo !== null) {
    return current.loopTo;
  }

  const nextIndex = index + 1;
  return nextIndex < state.instructions.length ? nextIndex : null;
}

export function hasMusicDslErrors(diagnostics: MusicDslDiagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function compileMusicDsl(
  dsl: string,
  metadata: SheetMetadata,
): MusicDslCompileResult {
  const diagnostics: MusicDslDiagnostic[] = [];
  const parsedStates: ParsedState[] = [];
  const stateNames = new Set<string>();
  const normalizedMetadata: SheetMetadata = {
    ...metadata,
    sectionCount: Math.max(0, Math.floor(metadata.sectionCount)),
  };

  const lines = dsl.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const parser = new LineParser(rawLine, index + 1, diagnostics);
    const parsedState = parser.parseState();

    if (!parsedState) {
      continue;
    }

    if (stateNames.has(parsedState.name)) {
      diagnostics.push({
        severity: "error",
        message: `Duplicate state '${parsedState.name}'.`,
        line: parsedState.line,
        column: parsedState.column,
        stateName: parsedState.name,
      });
      continue;
    }

    stateNames.add(parsedState.name);
    parsedStates.push(parsedState);
  }

  if (parsedStates.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      severity: "error",
      message: "Enter at least one state definition.",
      line: 1,
      column: 1,
    });
  }

  if (hasMusicDslErrors(diagnostics)) {
    return {
      program: null,
      diagnostics: diagnostics.sort(compareDiagnostics),
    };
  }

  const states: Record<string, CompiledState> = {};
  const stateOrder: string[] = [];

  for (const parsedState of parsedStates) {
    const compiledState = compileParsedState(
      parsedState,
      diagnostics,
      normalizedMetadata,
    );

    if (!compiledState) {
      continue;
    }

    states[compiledState.name] = compiledState;
    stateOrder.push(compiledState.name);
  }

  if (hasMusicDslErrors(diagnostics)) {
    return {
      program: null,
      diagnostics: diagnostics.sort(compareDiagnostics),
    };
  }

  const entryLabels = new Set<string>();

  for (const stateName of stateOrder) {
    const state = states[stateName]!;

    for (const label of Object.keys(state.entryPoints)) {
      entryLabels.add(label);
    }
  }

  for (const stateName of stateOrder) {
    const state = states[stateName]!;

    for (const instruction of state.instructions) {
      if (!instruction.exitLabel || entryLabels.has(instruction.exitLabel)) {
        continue;
      }

      diagnostics.push({
        severity: "warning",
        message: `Exit label '{${instruction.exitLabel}}' does not match any entry label in the program.`,
        line: instruction.line,
        column: instruction.column,
        stateName,
      });
    }
  }

  return {
    program: {
      metadata: normalizedMetadata,
      stateOrder,
      states,
    },
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

export function createNavigator(program: CompiledMusicProgram): Navigator {
  let currentStateName: string | null = null;
  let cursor: number | null = null;
  let pendingTargetStateName: string | null = null;

  function getCurrentState() {
    return currentStateName ? program.states[currentStateName] ?? null : null;
  }

  function resolveTransition(): ResolveTransitionResult {
    const state = getCurrentState();
    const instruction = getInstructionAt(state, cursor);

    if (!state || !instruction || !pendingTargetStateName) {
      return null;
    }

    const targetState = program.states[pendingTargetStateName];

    if (!targetState) {
      return null;
    }

    const entryIndex = resolveEntryIndex(targetState, instruction.exitLabel);

    if (entryIndex === null) {
      return null;
    }

    return {
      stateName: targetState.name,
      index: entryIndex,
      section: targetState.instructions[entryIndex]?.section ?? null,
    };
  }

  function getNextPosition() {
    const transition = resolveTransition();

    if (transition) {
      return transition;
    }

    const state = getCurrentState();

    if (!state || cursor === null) {
      return null;
    }

    const nextIndex = getNextIndex(state, cursor);

    if (nextIndex === null) {
      return null;
    }

    return {
      stateName: state.name,
      index: nextIndex,
      section: state.instructions[nextIndex]?.section ?? null,
    };
  }

  function getCurrentInstruction() {
    return getInstructionAt(getCurrentState(), cursor);
  }

  return {
    start(stateName) {
      const state = program.states[stateName];

      if (!state) {
        throw new Error(`Unknown state '${stateName}'.`);
      }

      currentStateName = stateName;
      cursor = state.instructions.length > 0 ? 0 : null;
      pendingTargetStateName = null;
    },
    current() {
      return getCurrentInstruction()?.section ?? null;
    },
    next() {
      return getNextPosition()?.section ?? null;
    },
    tick() {
      if (currentStateName === null || cursor === null) {
        return;
      }

      const transition = resolveTransition();

      if (transition) {
        currentStateName = transition.stateName;
        cursor = transition.index;
        pendingTargetStateName = null;
        return;
      }

      const state = getCurrentState();

      if (!state) {
        currentStateName = null;
        cursor = null;
        pendingTargetStateName = null;
        return;
      }

      const nextIndex = getNextIndex(state, cursor);

      if (nextIndex === null) {
        currentStateName = null;
        cursor = null;
        pendingTargetStateName = null;
        return;
      }

      cursor = nextIndex;
    },
    goTo(stateName) {
      if (!program.states[stateName]) {
        throw new Error(`Unknown state '${stateName}'.`);
      }

      pendingTargetStateName = stateName;
    },
    getStatus() {
      const next = getNextPosition();

      return {
        currentStateName,
        currentSection: getCurrentInstruction()?.section ?? null,
        currentInstructionIndex: cursor,
        nextStateName: next?.stateName ?? null,
        nextSection: next?.section ?? null,
        nextInstructionIndex: next?.index ?? null,
        pendingTargetStateName,
        nextComesFromPendingTransition: resolveTransition() !== null,
      };
    },
  };
}
