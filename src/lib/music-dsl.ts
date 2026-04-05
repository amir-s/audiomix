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
  trimMs?: number;
  sectionCount: number;
  sourceId?: string;
};

export type MusicDslInstructionIdentity = {
  stateName: string;
  sourceElementKey: string;
  sourceOccurrenceIndex: number;
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
  sourceElementKey: string;
  sourceOccurrenceIndex: number;
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
  start(stateName: string, instructionIndex?: number): void;
  current(): number | null;
  next(): number | null;
  tick(): void;
  goTo(stateName: string): void;
  getStatus(): NavigatorStatus;
};

export type ResolvedCompiledInstruction = {
  stateName: string;
  index: number;
  instruction: CompiledInstruction;
};

export type MusicDslEditResult = {
  dsl: string;
  compileResult: MusicDslCompileResult;
  selection: MusicDslInstructionIdentity | null;
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
  sourceKey: string;
};

type ParsedGroupElement = {
  kind: "group";
  elements: ParsedElement[];
  repetition: ParsedRepetition;
  fadeIn: boolean;
  fadeOut: boolean;
  line: number;
  column: number;
  sourceKey: string;
};

type ParsedElement = ParsedSectionElement | ParsedGroupElement;

type ParsedState = {
  name: string;
  elements: ParsedElement[];
  line: number;
  column: number;
};

type ParsedDocumentLine =
  | { kind: "blank"; rawText: string }
  | { kind: "raw"; rawText: string }
  | { kind: "state"; rawText: string; state: ParsedState };

type ParsedDocument = {
  lines: ParsedDocumentLine[];
};

type ParsedDocumentResult = {
  document: ParsedDocument;
  parsedStates: ParsedState[];
  diagnostics: MusicDslDiagnostic[];
};

type ResolveTransitionResult = {
  stateName: string;
  index: number;
  section: number | null;
} | null;

type EditableDocumentResult = {
  document: ParsedDocument;
  diagnostics: MusicDslDiagnostic[];
};

type ToggleMusicDslInstructionFadeOptions = {
  dsl: string;
  metadata: SheetMetadata;
  program: CompiledMusicProgram;
  target: MusicDslInstructionIdentity;
  field: "fadeIn" | "fadeOut";
};

type ConnectMusicDslInstructionsOptions = {
  dsl: string;
  metadata: SheetMetadata;
  program: CompiledMusicProgram;
  source: MusicDslInstructionIdentity;
  target: MusicDslInstructionIdentity;
  random?: () => number;
};

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

function formatSourceKey(path: number[]) {
  return path.join(".");
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

    const elements = this.parseElements({
      stopOnRightParen: false,
      pathPrefix: [],
    });

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
    pathPrefix,
  }: {
    stopOnRightParen: boolean;
    pathPrefix: number[];
  }) {
    const elements: ParsedElement[] = [];
    let childIndex = 0;

    while (true) {
      this.skipWhitespace();

      if (this.isAtEnd()) {
        break;
      }

      if (stopOnRightParen && this.peek() === ")") {
        break;
      }

      const element = this.parseElement([...pathPrefix, childIndex]);

      if (!element) {
        if (this.isAtEnd()) {
          break;
        }

        this.index += 1;
        continue;
      }

      elements.push(element);
      childIndex += 1;
    }

    return elements;
  }

  private parseElement(path: number[]): ParsedElement | null {
    this.skipWhitespace();

    const startColumn = this.getColumn();
    const sourceKey = formatSourceKey(path);
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

    const atom = this.parseAtom(sourceKey, path);

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

  private parseAtom(
    sourceKey: string,
    path: number[],
  ):
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
      const elements = this.parseElements({
        stopOnRightParen: true,
        pathPrefix: path,
      });

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
        sourceKey,
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
        sourceKey,
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

function buildParsedDocument(dsl: string): ParsedDocumentResult {
  const diagnostics: MusicDslDiagnostic[] = [];
  const parsedStates: ParsedState[] = [];
  const stateNames = new Set<string>();
  const lines: ParsedDocumentLine[] = [];
  const rawLines = dsl.split(/\r?\n/);

  for (const [index, rawLine] of rawLines.entries()) {
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      lines.push({ kind: "blank", rawText: rawLine });
      continue;
    }

    const parser = new LineParser(rawLine, index + 1, diagnostics);
    const parsedState = parser.parseState();

    if (!parsedState) {
      lines.push({ kind: "raw", rawText: rawLine });
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
      lines.push({ kind: "raw", rawText: rawLine });
      continue;
    }

    stateNames.add(parsedState.name);
    parsedStates.push(parsedState);
    lines.push({ kind: "state", rawText: rawLine, state: parsedState });
  }

  if (parsedStates.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      severity: "error",
      message: "Enter at least one state definition.",
      line: 1,
      column: 1,
    });
  }

  return {
    document: { lines },
    parsedStates,
    diagnostics,
  };
}

function cloneRepetition(repetition: ParsedRepetition): ParsedRepetition {
  return repetition.kind === "count"
    ? { kind: "count", count: repetition.count }
    : { kind: repetition.kind };
}

function cloneElement(element: ParsedElement): ParsedElement {
  if (element.kind === "section") {
    return {
      ...element,
      repetition: cloneRepetition(element.repetition),
    };
  }

  return {
    ...element,
    repetition: cloneRepetition(element.repetition),
    elements: element.elements.map(cloneElement),
  };
}

function cloneState(state: ParsedState): ParsedState {
  return {
    ...state,
    elements: state.elements.map(cloneElement),
  };
}

function cloneDocument(document: ParsedDocument): ParsedDocument {
  return {
    lines: document.lines.map((line) =>
      line.kind === "state"
        ? {
            kind: "state",
            rawText: line.rawText,
            state: cloneState(line.state),
          }
        : { ...line },
    ),
  };
}

function serializeRepetition(repetition: ParsedRepetition) {
  if (repetition.kind === "once") {
    return "";
  }

  if (repetition.kind === "forever") {
    return "+";
  }

  return `*${repetition.count.toString()}`;
}

function serializeElement(element: ParsedElement): string {
  if (element.kind === "section") {
    return [
      element.entryLabel ? `{${element.entryLabel}}` : "",
      element.fadeIn ? "!" : "",
      element.section.toString(),
      element.fadeOut ? "!" : "",
      element.exitLabel ? `{${element.exitLabel}}` : "",
      serializeRepetition(element.repetition),
    ].join("");
  }

  return [
    element.fadeIn ? "!" : "",
    `(${element.elements.map(serializeElement).join(" ")})`,
    element.fadeOut ? "!" : "",
    serializeRepetition(element.repetition),
  ].join("");
}

function serializeState(state: ParsedState) {
  return `${state.name}: ${state.elements.map(serializeElement).join(" ")}`;
}

function serializeDocument(document: ParsedDocument, touchedStates: Set<string>) {
  return document.lines
    .map((line) => {
      if (line.kind === "state" && touchedStates.has(line.state.name)) {
        return serializeState(line.state);
      }

      return line.rawText;
    })
    .join("\n");
}

function findStateLine(document: ParsedDocument, stateName: string) {
  return (
    document.lines.find(
      (line): line is Extract<ParsedDocumentLine, { kind: "state" }> =>
        line.kind === "state" && line.state.name === stateName,
    ) ?? null
  );
}

function findSectionElement(
  elements: ParsedElement[],
  sourceKey: string,
): ParsedSectionElement | null {
  for (const element of elements) {
    if (element.kind === "section") {
      if (element.sourceKey === sourceKey) {
        return element;
      }
      continue;
    }

    const nested = findSectionElement(element.elements, sourceKey);

    if (nested) {
      return nested;
    }
  }

  return null;
}

function collectLabelsFromElements(elements: ParsedElement[], labels: Set<string>) {
  for (const element of elements) {
    if (element.kind === "section") {
      if (element.entryLabel) {
        labels.add(element.entryLabel);
      }

      if (element.exitLabel) {
        labels.add(element.exitLabel);
      }

      continue;
    }

    collectLabelsFromElements(element.elements, labels);
  }
}

function collectLabels(document: ParsedDocument) {
  const labels = new Set<string>();

  for (const line of document.lines) {
    if (line.kind !== "state") {
      continue;
    }

    collectLabelsFromElements(line.state.elements, labels);
  }

  return labels;
}

function stateHasEntryLabelOnDifferentSource(
  state: ParsedState,
  label: string,
  sourceKey: string,
): boolean {
  function visit(elements: ParsedElement[]): boolean {
    for (const element of elements) {
      if (element.kind === "section") {
        if (element.sourceKey !== sourceKey && element.entryLabel === label) {
          return true;
        }

        continue;
      }

      if (visit(element.elements)) {
        return true;
      }
    }

    return false;
  }

  return visit(state.elements);
}

function materializeSectionFadesInElements(
  elements: ParsedElement[],
  inheritedFadeIn: boolean,
  inheritedFadeOut: boolean,
): ParsedElement[] {
  return elements.map((element) => {
    if (element.kind === "section") {
      return {
        ...element,
        fadeIn: inheritedFadeIn || element.fadeIn,
        fadeOut: inheritedFadeOut || element.fadeOut,
      };
    }

    return {
      ...element,
      fadeIn: false,
      fadeOut: false,
      elements: materializeSectionFadesInElements(
        element.elements,
        inheritedFadeIn || element.fadeIn,
        inheritedFadeOut || element.fadeOut,
      ),
    };
  });
}

function materializeStateSectionFades(state: ParsedState): ParsedState {
  return {
    ...state,
    elements: materializeSectionFadesInElements(state.elements, false, false),
  };
}

function flattenElements(
  elements: ParsedElement[],
  instructions: CompiledInstruction[],
  diagnostics: MusicDslDiagnostic[],
  stateName: string,
  sectionCount: number,
  sourceOccurrences: Map<string, number>,
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
      sourceOccurrences,
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
  sourceOccurrences: Map<string, number>,
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
        sourceOccurrences,
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
    sourceOccurrences,
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
  sourceOccurrences: Map<string, number>,
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
    const sourceOccurrenceIndex = sourceOccurrences.get(element.sourceKey) ?? 0;
    sourceOccurrences.set(element.sourceKey, sourceOccurrenceIndex + 1);

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
      sourceElementKey: element.sourceKey,
      sourceOccurrenceIndex,
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
    sourceOccurrences,
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
  const sourceOccurrences = new Map<string, number>();

  flattenElements(
    parsedState.elements,
    instructions,
    diagnostics,
    parsedState.name,
    metadata.sectionCount,
    sourceOccurrences,
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

function getEditableDocument(dsl: string): EditableDocumentResult {
  const result = buildParsedDocument(dsl);

  if (hasMusicDslErrors(result.diagnostics)) {
    throw new Error("The visual editor only supports valid DSL programs.");
  }

  return {
    document: result.document,
    diagnostics: result.diagnostics,
  };
}

function getCompileFailureMessage(compileResult: MusicDslCompileResult) {
  const firstError = compileResult.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  );

  return firstError?.message ?? "The visual edit produced an invalid DSL program.";
}

function finalizeDocumentEdit(
  document: ParsedDocument,
  touchedStates: Set<string>,
  metadata: SheetMetadata,
  selection: MusicDslInstructionIdentity | null,
): MusicDslEditResult {
  const nextDsl = serializeDocument(document, touchedStates);
  const compileResult = compileMusicDsl(nextDsl, metadata);

  if (!compileResult.program) {
    throw new Error(getCompileFailureMessage(compileResult));
  }

  return {
    dsl: nextDsl,
    compileResult,
    selection,
  };
}

export function hasMusicDslErrors(diagnostics: MusicDslDiagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function compileMusicDsl(
  dsl: string,
  metadata: SheetMetadata,
): MusicDslCompileResult {
  const { parsedStates, diagnostics } = buildParsedDocument(dsl);
  const normalizedMetadata: SheetMetadata = {
    ...metadata,
    sectionCount: Math.max(0, Math.floor(metadata.sectionCount)),
  };

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

export function getInstructionIdentity(
  stateName: string,
  instruction: CompiledInstruction,
): MusicDslInstructionIdentity {
  return {
    stateName,
    sourceElementKey: instruction.sourceElementKey,
    sourceOccurrenceIndex: instruction.sourceOccurrenceIndex,
  };
}

export function findCompiledInstructionByIdentity(
  program: CompiledMusicProgram,
  identity: MusicDslInstructionIdentity,
): ResolvedCompiledInstruction | null {
  const state = program.states[identity.stateName];

  if (!state) {
    return null;
  }

  const index = state.instructions.findIndex(
    (instruction) =>
      instruction.sourceElementKey === identity.sourceElementKey &&
      instruction.sourceOccurrenceIndex === identity.sourceOccurrenceIndex,
  );

  if (index < 0) {
    return null;
  }

  return {
    stateName: identity.stateName,
    index,
    instruction: state.instructions[index]!,
  };
}

export function findFirstCompiledInstructionForSource(
  program: CompiledMusicProgram,
  stateName: string,
  sourceElementKey: string,
): ResolvedCompiledInstruction | null {
  const state = program.states[stateName];

  if (!state) {
    return null;
  }

  const index = state.instructions.findIndex(
    (instruction) => instruction.sourceElementKey === sourceElementKey,
  );

  if (index < 0) {
    return null;
  }

  return {
    stateName,
    index,
    instruction: state.instructions[index]!,
  };
}

export function createFreshMusicDslLabel(
  usedLabels: Set<string>,
  random: () => number = Math.random,
) {
  const letters = "abcdefghijklmnopqrstuvwxyz";

  for (const length of [1, 2]) {
    const candidates: string[] = [];

    if (length === 1) {
      for (const letter of letters) {
        if (!usedLabels.has(letter)) {
          candidates.push(letter);
        }
      }
    } else {
      for (const first of letters) {
        for (const second of letters) {
          const label = `${first}${second}`;

          if (!usedLabels.has(label)) {
            candidates.push(label);
          }
        }
      }
    }

    if (candidates.length > 0) {
      const candidateIndex = Math.max(
        0,
        Math.min(
          candidates.length - 1,
          Math.floor(random() * candidates.length),
        ),
      );

      return candidates[candidateIndex]!;
    }
  }

  throw new Error("No labels are available for a new visual connection.");
}

export function toggleMusicDslInstructionFade({
  dsl,
  metadata,
  program,
  target,
  field,
}: ToggleMusicDslInstructionFadeOptions): MusicDslEditResult {
  const { document } = getEditableDocument(dsl);
  const nextDocument = cloneDocument(document);
  const resolvedTarget = findCompiledInstructionByIdentity(program, target);

  if (!resolvedTarget) {
    throw new Error("The selected visual node no longer exists.");
  }

  const stateLine = findStateLine(nextDocument, resolvedTarget.stateName);

  if (!stateLine) {
    throw new Error(`Unknown state '${resolvedTarget.stateName}'.`);
  }

  stateLine.state = materializeStateSectionFades(stateLine.state);

  const section = findSectionElement(
    stateLine.state.elements,
    resolvedTarget.instruction.sourceElementKey,
  );

  if (!section) {
    throw new Error("The selected visual node could not be mapped back to the DSL.");
  }

  section[field] = !resolvedTarget.instruction[field];

  return finalizeDocumentEdit(
    nextDocument,
    new Set([resolvedTarget.stateName]),
    metadata,
    target,
  );
}

export function connectMusicDslInstructions({
  dsl,
  metadata,
  program,
  source,
  target,
  random = Math.random,
}: ConnectMusicDslInstructionsOptions): MusicDslEditResult {
  const { document } = getEditableDocument(dsl);
  const nextDocument = cloneDocument(document);
  const resolvedSource = findCompiledInstructionByIdentity(program, source);
  const resolvedTarget = findCompiledInstructionByIdentity(program, target);

  if (!resolvedSource || !resolvedTarget) {
    throw new Error("One of the selected visual nodes no longer exists.");
  }

  const canonicalTarget =
    findFirstCompiledInstructionForSource(
      program,
      resolvedTarget.stateName,
      resolvedTarget.instruction.sourceElementKey,
    ) ?? resolvedTarget;

  const sourceStateLine = findStateLine(nextDocument, resolvedSource.stateName);
  const targetStateLine = findStateLine(nextDocument, canonicalTarget.stateName);

  if (!sourceStateLine || !targetStateLine) {
    throw new Error("The selected visual nodes could not be mapped back to the DSL.");
  }

  const sourceSection = findSectionElement(
    sourceStateLine.state.elements,
    resolvedSource.instruction.sourceElementKey,
  );
  const targetSection = findSectionElement(
    targetStateLine.state.elements,
    canonicalTarget.instruction.sourceElementKey,
  );

  if (!sourceSection || !targetSection) {
    throw new Error("The selected visual nodes could not be mapped back to the DSL.");
  }

  const usedLabels = collectLabels(nextDocument);
  const sourceLabel = resolvedSource.instruction.exitLabel;
  const targetLabel = canonicalTarget.instruction.entryLabel;
  let nextLabel: string;

  if (sourceLabel && targetLabel) {
    nextLabel = sourceLabel === targetLabel ? sourceLabel : targetLabel;
  } else if (targetLabel) {
    nextLabel = targetLabel;
  } else if (sourceLabel) {
    nextLabel = stateHasEntryLabelOnDifferentSource(
      targetStateLine.state,
      sourceLabel,
      targetSection.sourceKey,
    )
      ? createFreshMusicDslLabel(usedLabels, random)
      : sourceLabel;
  } else {
    nextLabel = createFreshMusicDslLabel(usedLabels, random);
  }

  sourceSection.exitLabel = nextLabel;
  targetSection.entryLabel = nextLabel;

  return finalizeDocumentEdit(
    nextDocument,
    new Set([resolvedSource.stateName, canonicalTarget.stateName]),
    metadata,
    source,
  );
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
    start(stateName, instructionIndex = 0) {
      const state = program.states[stateName];

      if (!state) {
        throw new Error(`Unknown state '${stateName}'.`);
      }

      if (
        instructionIndex < 0 ||
        instructionIndex >= state.instructions.length
      ) {
        throw new Error(
          `Instruction ${instructionIndex.toString()} is out of range for state '${stateName}'.`,
        );
      }

      currentStateName = stateName;
      cursor = state.instructions.length > 0 ? instructionIndex : null;
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
