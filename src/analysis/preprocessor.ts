export function applyConditionalCompilation(
  rawLines: string[],
  maskedLines: string[],
  initialMacros: string[] = []
): string[] {
  const macros = macroMapFromDefinitions(initialMacros);
  const frames: ConditionalFrame[] = [];
  return maskedLines.map((line) => {
    const currentActive = conditionalStackActive(frames);
    const directive = parseDirective(line);
    if (!directive) {
      return currentActive ? line : blankLike(line);
    }

    if (directive.name === "if" || directive.name === "ifdef" || directive.name === "ifndef") {
      const parentActive = currentActive;
      const condition = directive.name === "ifdef"
        ? macros.has(firstIdentifier(directive.args) ?? "")
        : directive.name === "ifndef"
          ? !macros.has(firstIdentifier(directive.args) ?? "")
          : evaluatePreprocessorExpression(directive.args, macros);
      frames.push({
        parentActive,
        branchActive: parentActive && condition,
        branchTaken: parentActive && condition
      });
      return parentActive ? line : blankLike(line);
    }

    if (directive.name === "elif") {
      const frame = frames.at(-1);
      if (!frame) {
        return currentActive ? line : blankLike(line);
      }
      const condition = evaluatePreprocessorExpression(directive.args, macros);
      frame.branchActive = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken = frame.branchTaken || frame.branchActive;
      return frame.parentActive ? line : blankLike(line);
    }

    if (directive.name === "else") {
      const frame = frames.at(-1);
      if (!frame) {
        return currentActive ? line : blankLike(line);
      }
      frame.branchActive = frame.parentActive && !frame.branchTaken;
      frame.branchTaken = true;
      return frame.parentActive ? line : blankLike(line);
    }

    if (directive.name === "endif") {
      const parentActive = frames.at(-1)?.parentActive ?? currentActive;
      frames.pop();
      return parentActive ? line : blankLike(line);
    }

    if (directive.name === "define") {
      if (currentActive) {
        const definition = parseDefine(directive.args);
        if (definition) {
          macros.set(definition.name, definition.value);
        }
      }
      return currentActive ? line : blankLike(line);
    }

    if (directive.name === "undef") {
      if (currentActive) {
        const name = firstIdentifier(directive.args);
        if (name) {
          macros.delete(name);
        }
      }
      return currentActive ? line : blankLike(line);
    }

    return currentActive ? line : blankLike(line);
  });
}

export interface ConditionalIncludeDirective {
  path: string;
  quoted: boolean;
}

export interface ConditionalIncludeFile {
  file: string;
  rawLines: string[];
  maskedLines: string[];
}

export interface ConditionalCompilationIncludeOptions {
  file?: string;
  maxIncludeDepth?: number;
  readIncludeFile?: (
    include: ConditionalIncludeDirective,
    fromFile: string | undefined
  ) => Promise<ConditionalIncludeFile | undefined>;
}

export async function applyConditionalCompilationWithIncludes(
  rawLines: string[],
  maskedLines: string[],
  initialMacros: string[] = [],
  options: ConditionalCompilationIncludeOptions = {}
): Promise<string[]> {
  const macros = macroMapFromDefinitions(initialMacros);
  const includeStack = new Set<string>();
  if (options.file) {
    includeStack.add(includeStackKey(options.file));
  }
  return processConditionalCompilationWithIncludes(rawLines, maskedLines, macros, options, includeStack, 0);
}

export function macroMapFromDefinitions(definitions: string[]): Map<string, string> {
  const macros = new Map<string, string>();
  for (const definition of definitions) {
    const normalized = normalizeMacroDefinition(definition);
    if (normalized) {
      macros.set(normalized.name, normalized.value);
    }
  }
  return macros;
}

export function normalizeMacroDefinition(definition: string): { name: string; value: string } | undefined {
  const trimmed = definition.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return undefined;
  }
  const equals = trimmed.indexOf("=");
  const name = (equals >= 0 ? trimmed.slice(0, equals) : trimmed).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return undefined;
  }
  const value = equals >= 0 ? trimmed.slice(equals + 1).trim() : "1";
  return { name, value: value || "1" };
}

interface ConditionalFrame {
  parentActive: boolean;
  branchActive: boolean;
  branchTaken: boolean;
}

interface Directive {
  name: string;
  args: string;
}

type Token =
  | { kind: "identifier"; value: string }
  | { kind: "number"; value: number }
  | { kind: "operator"; value: "!" | "&&" | "||" | "==" | "!=" | "(" | ")" };
type OperatorValue = Extract<Token, { kind: "operator" }>["value"];

function conditionalStackActive(frames: ConditionalFrame[]): boolean {
  return frames.every((frame) => frame.branchActive);
}

function parseDirective(line: string): Directive | undefined {
  const match = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif|define|undef|include)\b(.*)$/);
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : undefined;
}

async function processConditionalCompilationWithIncludes(
  rawLines: string[],
  maskedLines: string[],
  macros: Map<string, string>,
  options: ConditionalCompilationIncludeOptions,
  includeStack: Set<string>,
  includeDepth: number
): Promise<string[]> {
  const frames: ConditionalFrame[] = [];
  const output: string[] = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index] ?? "";
    const currentActive = conditionalStackActive(frames);
    const directive = parseDirective(line);
    if (!directive) {
      output.push(currentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "if" || directive.name === "ifdef" || directive.name === "ifndef") {
      const parentActive = currentActive;
      const condition = directive.name === "ifdef"
        ? macros.has(firstIdentifier(directive.args) ?? "")
        : directive.name === "ifndef"
          ? !macros.has(firstIdentifier(directive.args) ?? "")
          : evaluatePreprocessorExpression(directive.args, macros);
      frames.push({
        parentActive,
        branchActive: parentActive && condition,
        branchTaken: parentActive && condition
      });
      output.push(parentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "elif") {
      const frame = frames.at(-1);
      if (!frame) {
        output.push(currentActive ? line : blankLike(line));
        continue;
      }
      const condition = evaluatePreprocessorExpression(directive.args, macros);
      frame.branchActive = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken = frame.branchTaken || frame.branchActive;
      output.push(frame.parentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "else") {
      const frame = frames.at(-1);
      if (!frame) {
        output.push(currentActive ? line : blankLike(line));
        continue;
      }
      frame.branchActive = frame.parentActive && !frame.branchTaken;
      frame.branchTaken = true;
      output.push(frame.parentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "endif") {
      const parentActive = frames.at(-1)?.parentActive ?? currentActive;
      frames.pop();
      output.push(parentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "define") {
      if (currentActive) {
        const definition = parseDefine(directive.args);
        if (definition) {
          macros.set(definition.name, definition.value);
        }
      }
      output.push(currentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "undef") {
      if (currentActive) {
        const name = firstIdentifier(directive.args);
        if (name) {
          macros.delete(name);
        }
      }
      output.push(currentActive ? line : blankLike(line));
      continue;
    }

    if (directive.name === "include") {
      if (currentActive) {
        await applyIncludeMacroSideEffects(
          rawLines[index] ?? line,
          macros,
          options,
          includeStack,
          includeDepth
        );
      }
      output.push(currentActive ? line : blankLike(line));
      continue;
    }

    output.push(currentActive ? line : blankLike(line));
  }
  return output;
}

async function applyIncludeMacroSideEffects(
  rawLine: string,
  macros: Map<string, string>,
  options: ConditionalCompilationIncludeOptions,
  includeStack: Set<string>,
  includeDepth: number
): Promise<void> {
  const maxIncludeDepth = options.maxIncludeDepth ?? 64;
  if (!options.readIncludeFile || includeDepth >= maxIncludeDepth) {
    return;
  }
  const include = parseIncludeDirective(rawLine);
  if (!include) {
    return;
  }
  const included = await options.readIncludeFile(include, options.file);
  if (!included) {
    return;
  }
  const key = includeStackKey(included.file);
  if (includeStack.has(key)) {
    return;
  }
  includeStack.add(key);
  try {
    await processConditionalCompilationWithIncludes(
      included.rawLines,
      included.maskedLines,
      macros,
      { ...options, file: included.file },
      includeStack,
      includeDepth + 1
    );
  } finally {
    includeStack.delete(key);
  }
}

function parseIncludeDirective(rawLine: string): ConditionalIncludeDirective | undefined {
  const match = rawLine.match(/^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/);
  const includePath = match?.[1] ?? match?.[2];
  if (!includePath) {
    return undefined;
  }
  return { path: includePath.trim(), quoted: Boolean(match?.[1]) };
}

function includeStackKey(file: string): string {
  return file.replace(/\\/g, "/").toLowerCase();
}

function parseDefine(args: string): { name: string; value: string } | undefined {
  const match = args.match(/^([A-Za-z_]\w*)(?:\s*\([^)]*\))?\s*(.*)$/);
  if (!match) {
    return undefined;
  }
  return { name: match[1], value: (match[2] ?? "").trim() || "1" };
}

function firstIdentifier(value: string): string | undefined {
  return value.match(/[A-Za-z_]\w*/)?.[0];
}

function evaluatePreprocessorExpression(expression: string, macros: Map<string, string>): boolean {
  const parser = new ExpressionParser(tokenizeExpression(expression), macros);
  return parser.parse() !== 0;
}

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const two = expression.slice(index, index + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      tokens.push({ kind: "operator", value: two });
      index += 2;
      continue;
    }
    if (char === "!" || char === "(" || char === ")") {
      tokens.push({ kind: "operator", value: char });
      index += 1;
      continue;
    }
    const number = expression.slice(index).match(/^(?:0x[0-9A-Fa-f]+|\d+)/);
    if (number) {
      tokens.push({ kind: "number", value: parseInteger(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = expression.slice(index).match(/^[A-Za-z_]\w*/);
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    index += 1;
  }
  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly macros: Map<string, string>
  ) {}

  parse(): number {
    return this.parseOr();
  }

  private parseOr(): number {
    let value = this.parseAnd();
    while (this.consumeOperator("||")) {
      const right = this.parseAnd();
      value = value !== 0 || right !== 0 ? 1 : 0;
    }
    return value;
  }

  private parseAnd(): number {
    let value = this.parseEquality();
    while (this.consumeOperator("&&")) {
      const right = this.parseEquality();
      value = value !== 0 && right !== 0 ? 1 : 0;
    }
    return value;
  }

  private parseEquality(): number {
    let value = this.parseUnary();
    while (true) {
      if (this.consumeOperator("==")) {
        value = value === this.parseUnary() ? 1 : 0;
        continue;
      }
      if (this.consumeOperator("!=")) {
        value = value !== this.parseUnary() ? 1 : 0;
        continue;
      }
      return value;
    }
  }

  private parseUnary(): number {
    if (this.consumeOperator("!")) {
      return this.parseUnary() === 0 ? 1 : 0;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.index];
    if (!token) {
      return 0;
    }
    if (token.kind === "number") {
      this.index += 1;
      return token.value;
    }
    if (token.kind === "identifier" && token.value === "defined") {
      this.index += 1;
      const parenthesized = this.consumeOperator("(");
      const name = this.consumeIdentifier();
      if (parenthesized) {
        this.consumeOperator(")");
      }
      return name && this.macros.has(name) ? 1 : 0;
    }
    if (token.kind === "identifier") {
      this.index += 1;
      return macroValue(token.value, this.macros);
    }
    if (this.consumeOperator("(")) {
      const value = this.parseOr();
      this.consumeOperator(")");
      return value;
    }
    this.index += 1;
    return 0;
  }

  private consumeIdentifier(): string | undefined {
    const token = this.tokens[this.index];
    if (token?.kind !== "identifier") {
      return undefined;
    }
    this.index += 1;
    return token.value;
  }

  private consumeOperator(value: OperatorValue): boolean {
    const token = this.tokens[this.index];
    if (token?.kind === "operator" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }
}

function macroValue(name: string, macros: Map<string, string>): number {
  const value = macros.get(name);
  if (value === undefined) {
    return 0;
  }
  const numeric = value.match(/^\s*(?:0x[0-9A-Fa-f]+|-?\d+)/)?.[0];
  return numeric ? parseInteger(numeric) : 1;
}

function parseInteger(value: string): number {
  return value.toLowerCase().startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
}

function blankLike(line: string): string {
  return " ".repeat(line.length);
}
