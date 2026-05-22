import * as fs from "node:fs/promises";
import { normalizePath } from "./pathUtils";
import type {
  FileAnalysis,
  FileSignature,
  FunctionInfo,
  GlobalVariable,
  SourceLocation,
  UnresolvedEvidence,
  VariableAccess
} from "./types";

interface BodyLine {
  line: number;
  raw: string;
  masked: string;
}

export interface FunctionStructure {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  bodyLines: BodyLine[];
}

export interface FileStructure {
  file: string;
  signature: FileSignature;
  globals: GlobalVariable[];
  functions: FunctionStructure[];
  unresolved: UnresolvedEvidence[];
}

interface CommentState {
  inBlockComment: boolean;
}

export async function getFileSignature(file: string): Promise<FileSignature> {
  const stat = await fs.stat(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

export async function scanFileStructure(file: string): Promise<FileStructure> {
  const normalizedFile = normalizePath(file);
  const text = await fs.readFile(normalizedFile, "utf8");
  const signature = await getFileSignature(normalizedFile);
  const rawLines = text.split(/\r?\n/);
  const state: CommentState = { inBlockComment: false };
  const maskedLines = rawLines.map((line) => maskCommentsAndStrings(line, state));

  const globals: GlobalVariable[] = [];
  const functions: FunctionStructure[] = [];
  const unresolved: UnresolvedEvidence[] = [];
  let pending = "";
  let pendingStartLine = 1;
  let blockDepth = 0;
  let activeFunction: FunctionStructure | undefined;
  let functionBraceDepth = 0;

  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNumber = index + 1;
    const masked = maskedLines[index] ?? "";
    const raw = rawLines[index] ?? "";
    const trimmed = masked.trim();

    if (/^\s*#\s*define\b/.test(masked)) {
      unresolved.push({
        kind: "macro",
        location: location(normalizedFile, lineNumber, raw),
        evidence: raw.trim(),
        note: "マクロ定義は静的なread/write分類では展開していません。"
      });
    }
    if (/^\s*#/.test(masked)) {
      continue;
    }

    if (activeFunction) {
      activeFunction.bodyLines.push({ line: lineNumber, raw, masked });
      functionBraceDepth += countChar(masked, "{") - countChar(masked, "}");
      if (functionBraceDepth <= 0) {
        activeFunction.endLine = lineNumber;
        functions.push(activeFunction);
        activeFunction = undefined;
      }
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (blockDepth > 0) {
      blockDepth += countChar(masked, "{") - countChar(masked, "}");
      continue;
    }

    if (!pending) {
      pendingStartLine = lineNumber;
    }
    pending = `${pending} ${trimmed}`.trim();

    if (pending.includes("{")) {
      const beforeBrace = pending.slice(0, pending.indexOf("{")).trim();
      const functionName = extractFunctionName(beforeBrace);
      if (functionName) {
        activeFunction = {
          name: functionName,
          file: normalizedFile,
          startLine: pendingStartLine,
          endLine: lineNumber,
          signature: beforeBrace.replace(/\s+/g, " "),
          bodyLines: [{ line: lineNumber, raw, masked }]
        };
        functionBraceDepth = countChar(masked, "{") - countChar(masked, "}");
        pending = "";
        if (functionBraceDepth <= 0) {
          functions.push(activeFunction);
          activeFunction = undefined;
        }
        continue;
      }

      if (/^(typedef\s+)?(struct|class|enum|namespace)\b/.test(beforeBrace)) {
        blockDepth = countChar(masked, "{") - countChar(masked, "}");
        pending = "";
        continue;
      }
    }

    if (pending.includes(";")) {
      const parts = pending.split(";");
      for (let partIndex = 0; partIndex < parts.length - 1; partIndex += 1) {
        const statement = parts[partIndex]?.trim();
        if (!statement) {
          continue;
        }
        globals.push(
          ...parseGlobalStatement(statement, {
            file: normalizedFile,
            line: pendingStartLine,
            text: raw.trim()
          })
        );
      }
      pending = parts[parts.length - 1]?.trim() ?? "";
      pendingStartLine = lineNumber;
    }
  }

  return {
    file: normalizedFile,
    signature,
    globals,
    functions,
    unresolved
  };
}

export function analyzeFileStructure(
  structure: FileStructure,
  globalNames: Set<string>,
  knownFunctionNames: Set<string>
): FileAnalysis {
  const functions = structure.functions.map((func) =>
    analyzeFunction(func, globalNames, knownFunctionNames)
  );
  return {
    file: structure.file,
    signature: structure.signature,
    globals: structure.globals,
    functions,
    unresolved: structure.unresolved
  };
}

function analyzeFunction(
  func: FunctionStructure,
  globalNames: Set<string>,
  knownFunctionNames: Set<string>
): FunctionInfo {
  const accesses: VariableAccess[] = [];
  const unresolved: UnresolvedEvidence[] = [];
  const calls = new Set<string>();

  for (const bodyLine of func.bodyLines) {
    const masked = bodyLine.masked;
    const raw = bodyLine.raw;
    if (/\b(__asm|asm)\b/.test(masked)) {
      unresolved.push({
        kind: "inline-asm",
        functionName: func.name,
        location: location(func.file, bodyLine.line, raw),
        evidence: raw.trim(),
        note: "inline assembly内のメモリアクセスは解析対象外です。"
      });
    }
    if (/\(\s*\*\s*[A-Za-z_]\w*\s*\)\s*\(/.test(masked)) {
      unresolved.push({
        kind: "function-pointer",
        functionName: func.name,
        location: location(func.file, bodyLine.line, raw),
        evidence: raw.trim(),
        note: "関数ポインタ呼び出しは呼び出し先を断定していません。"
      });
    }
    if (/\*\s*[A-Za-z_]\w*\s*=/.test(masked)) {
      unresolved.push({
        kind: "pointer-write",
        functionName: func.name,
        location: location(func.file, bodyLine.line, raw),
        evidence: raw.trim(),
        note: "ポインタ経由の書き込みは別名先を断定していません。"
      });
    }

    for (const variableName of globalNames) {
      if (!containsWord(masked, variableName)) {
        continue;
      }
      const { kind, reasons } = classifyAccess(masked, variableName);
      accesses.push({
        variableName,
        functionName: func.name,
        kind,
        location: location(func.file, bodyLine.line, raw),
        evidence: raw.trim(),
        reasons
      });
      if (reasons.includes("address-taken")) {
        unresolved.push({
          kind: "address-taken",
          functionName: func.name,
          variableName,
          location: location(func.file, bodyLine.line, raw),
          evidence: raw.trim(),
          note: "グローバル変数のアドレス取得があり、以降の別名更新は断定していません。"
        });
      }
    }

    for (const functionName of knownFunctionNames) {
      if (functionName === func.name) {
        continue;
      }
      const simpleName = simplifyFunctionName(functionName);
      if (containsCall(masked, simpleName)) {
        calls.add(functionName);
      }
    }
  }

  return {
    name: func.name,
    file: func.file,
    startLine: func.startLine,
    endLine: func.endLine,
    signature: func.signature,
    calls: [...calls].sort(),
    accesses,
    unresolved
  };
}

function parseGlobalStatement(
  statement: string,
  source: Pick<SourceLocation, "file" | "line" | "text">
): GlobalVariable[] {
  const normalized = statement.replace(/\s+/g, " ").trim();
  if (!normalized || shouldSkipGlobalStatement(normalized)) {
    return [];
  }
  const isExtern = /\bextern\b/.test(normalized);
  const result: GlobalVariable[] = [];
  const declarationParts = normalized.split(",");

  for (const rawPart of declarationParts) {
    const beforeInitializer = rawPart.split("=")[0]?.trim() ?? "";
    const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(beforeInitializer);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1];
    if (isKeyword(name)) {
      continue;
    }
    result.push({
      name,
      file: source.file,
      line: source.line,
      declaration: normalized,
      isExtern
    });
  }
  return result;
}

function shouldSkipGlobalStatement(statement: string): boolean {
  if (/^#/.test(statement)) {
    return true;
  }
  if (/\b(typedef|using|return|goto|break|continue)\b/.test(statement)) {
    return true;
  }
  if (/^(if|for|while|switch|catch)\b/.test(statement)) {
    return true;
  }
  if (statement.includes("(") || statement.includes(")")) {
    return true;
  }
  if (/^(struct|class|enum|namespace)\b/.test(statement)) {
    return true;
  }
  return false;
}

function extractFunctionName(signature: string): string | undefined {
  const normalized = signature.replace(/\s+/g, " ").trim();
  if (!normalized || /^(if|for|while|switch|catch|return|sizeof)\b/.test(normalized)) {
    return undefined;
  }
  if (!normalized.includes("(") || !normalized.includes(")") || normalized.includes(";")) {
    return undefined;
  }
  const match = /([~A-Za-z_]\w*(?:::[~A-Za-z_]\w*)?)\s*\([^(){};]*\)\s*(?:const)?\s*$/.exec(
    normalized
  );
  return match?.[1];
}

function classifyAccess(line: string, variableName: string): { kind: "read" | "write" | "unknown"; reasons: string[] } {
  const escaped = escapeRegExp(variableName);
  const reasons: string[] = [];
  if (new RegExp(`(?:\\+\\+|--)\\s*${escaped}\\b|\\b${escaped}\\s*(?:\\+\\+|--)`).test(line)) {
    reasons.push("increment-decrement");
    return { kind: "write", reasons };
  }
  if (
    new RegExp(
      `\\b${escaped}\\b\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=|\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|<<=|>>=)`
    ).test(line)
  ) {
    reasons.push("assignment");
    return { kind: "write", reasons };
  }
  if (new RegExp(`&\\s*${escaped}\\b`).test(line)) {
    reasons.push("address-taken");
    return { kind: "unknown", reasons };
  }
  reasons.push("read-reference");
  return { kind: "read", reasons };
}

function maskCommentsAndStrings(line: string, state: CommentState): string {
  let output = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (state.inBlockComment) {
      if (char === "*" && next === "/") {
        state.inBlockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += " ";
      }
      continue;
    }
    if (char === "/" && next === "*") {
      state.inBlockComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      output += " ".repeat(line.length - index);
      break;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      output += " ";
      index += 1;
      while (index < line.length) {
        const quotedChar = line[index];
        output += " ";
        if (quotedChar === "\\" && index + 1 < line.length) {
          index += 1;
          output += " ";
        } else if (quotedChar === quote) {
          break;
        }
        index += 1;
      }
      continue;
    }
    output += char;
  }
  return output;
}

function containsWord(line: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(line);
}

function containsCall(line: string, functionName: string): boolean {
  return new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`).test(line);
}

function simplifyFunctionName(functionName: string): string {
  const parts = functionName.split("::");
  return parts[parts.length - 1] ?? functionName;
}

function location(file: string, line: number, raw: string): SourceLocation {
  return { file, line, text: raw.trim() };
}

function countChar(value: string, char: string): number {
  return [...value].filter((item) => item === char).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isKeyword(value: string): boolean {
  return new Set([
    "int",
    "char",
    "short",
    "long",
    "float",
    "double",
    "void",
    "const",
    "volatile",
    "static",
    "extern",
    "unsigned",
    "signed",
    "struct",
    "class",
    "enum"
  ]).has(value);
}
