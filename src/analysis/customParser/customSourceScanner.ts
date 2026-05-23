import * as fs from "node:fs/promises";
import { normalizePath } from "../pathUtils";
import type { BodyLine, FileStructure, FunctionStructure } from "../fileStructure";
import type {
  FileSignature,
  GlobalVariable,
  SourceLocation,
  StructMemberInfo,
  StructTypeInfo,
  UnresolvedEvidence
} from "../types";

interface ParserLine {
  line: number;
  raw: string;
  masked: string;
  trimmed: string;
}

interface CommentState {
  inBlockComment: boolean;
}

const SOURCE_CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof"
]);

const DECLARATION_QUALIFIERS = new Set([
  "auto",
  "const",
  "extern",
  "register",
  "signed",
  "static",
  "unsigned",
  "volatile"
]);

export async function scanFileStructureWithCustomParser(file: string): Promise<FileStructure> {
  const normalizedFile = normalizePath(file);
  const text = await fs.readFile(normalizedFile, "utf8");
  const signature = await getFileSignature(normalizedFile);
  return new CustomSourceParser(normalizedFile, text, signature).parse();
}

async function getFileSignature(file: string): Promise<FileSignature> {
  const stat = await fs.stat(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

class CustomSourceParser {
  private readonly lines: ParserLine[];

  constructor(
    private readonly file: string,
    text: string,
    private readonly signature: FileSignature
  ) {
    const rawLines = text.split(/\r?\n/);
    const state: CommentState = { inBlockComment: false };
    this.lines = rawLines.map((raw, index) => {
      const masked = maskCommentsAndStrings(raw, state);
      return {
        line: index + 1,
        raw,
        masked,
        trimmed: masked.trim()
      };
    });
  }

  parse(): FileStructure {
    const globals: GlobalVariable[] = [];
    const functions: FunctionStructure[] = [];
    const unresolved: UnresolvedEvidence[] = [];
    const structTypes = this.parseStructTypes();
    let pending = "";
    let pendingStartLine = 1;
    let blockDepth = 0;
    let activeFunction: FunctionStructure | undefined;
    let functionBraceDepth = 0;

    for (const line of this.lines) {
      if (/^\s*#\s*define\b/.test(line.masked)) {
        unresolved.push({
          kind: "macro",
          location: location(this.file, line.line, line.raw),
          evidence: line.raw.trim(),
          note: "マクロ定義は独自解析器では展開していません。"
        });
      }
      if (/^\s*#/.test(line.masked)) {
        continue;
      }

      if (activeFunction) {
        activeFunction.bodyLines.push(toBodyLine(line));
        functionBraceDepth += countChar(line.masked, "{") - countChar(line.masked, "}");
        if (functionBraceDepth <= 0) {
          activeFunction.endLine = line.line;
          functions.push(activeFunction);
          activeFunction = undefined;
        }
        continue;
      }

      if (!line.trimmed) {
        continue;
      }

      if (blockDepth > 0) {
        blockDepth += countChar(line.masked, "{") - countChar(line.masked, "}");
        continue;
      }

      if (!pending) {
        pendingStartLine = line.line;
      }
      pending = `${pending} ${line.trimmed}`.trim();

      if (pending.includes("{")) {
        const beforeBrace = pending.slice(0, pending.indexOf("{")).trim();
        const functionName = extractFunctionName(beforeBrace);
        if (functionName) {
          activeFunction = {
            name: functionName,
            file: this.file,
            startLine: pendingStartLine,
            endLine: line.line,
            signature: beforeBrace.replace(/\s+/g, " "),
            bodyLines: [toBodyLine(line)]
          };
          functionBraceDepth = countChar(line.masked, "{") - countChar(line.masked, "}");
          pending = "";
          if (functionBraceDepth <= 0) {
            functions.push(activeFunction);
            activeFunction = undefined;
          }
          continue;
        }

        if (/^(typedef\s+)?(struct|class|enum|namespace)\b/.test(beforeBrace)) {
          blockDepth = countChar(line.masked, "{") - countChar(line.masked, "}");
          pending = "";
          continue;
        }
      }

      if (pending.includes(";")) {
        const statements = pending.split(";");
        for (let index = 0; index < statements.length - 1; index += 1) {
          const statement = statements[index]?.trim();
          if (statement) {
            globals.push(...parseGlobalStatement(statement, this.file, pendingStartLine));
          }
        }
        pending = statements[statements.length - 1]?.trim() ?? "";
        pendingStartLine = line.line;
      }
    }

    return {
      file: this.file,
      signature: this.signature,
      globals,
      structTypes,
      functions,
      unresolved
    };
  }

  private parseStructTypes(): StructTypeInfo[] {
    const structs: StructTypeInfo[] = [];
    for (let index = 0; index < this.lines.length; index += 1) {
      const line = this.lines[index]!;
      const startMatch = /^\s*typedef\s+struct\s+([A-Za-z_]\w*)?\s*\{/.exec(line.masked);
      if (!startMatch) {
        continue;
      }

      const tagName = startMatch[1];
      const startLine = line.line;
      const declarationLines = [line.raw.trim()];
      const bodyLines: ParserLine[] = [];
      let depth = countChar(line.masked, "{") - countChar(line.masked, "}");
      let closingTail = "";

      while (index + 1 < this.lines.length && depth > 0) {
        index += 1;
        const current = this.lines[index]!;
        declarationLines.push(current.raw.trim());
        const closeIndex = current.masked.indexOf("}");
        if (closeIndex >= 0) {
          const beforeClose = current.masked.slice(0, closeIndex);
          if (beforeClose.trim()) {
            bodyLines.push({ ...current, masked: beforeClose, trimmed: beforeClose.trim() });
          }
          closingTail = current.masked.slice(closeIndex + 1);
        } else {
          bodyLines.push(current);
        }
        depth += countChar(current.masked, "{") - countChar(current.masked, "}");
      }

      const aliasName = /^\s*([A-Za-z_]\w*)/.exec(closingTail)?.[1];
      const name = aliasName ?? tagName ?? `anonymous_struct_${startLine}`;
      structs.push({
        name,
        aliases: uniqueStrings([tagName, aliasName].filter((value): value is string => Boolean(value) && value !== name)),
        file: this.file,
        line: startLine,
        declaration: declarationLines.filter(Boolean).join(" "),
        members: bodyLines.flatMap((memberLine) => parseStructMembers(memberLine, this.file))
      });
    }
    return structs;
  }
}

function parseStructMembers(line: ParserLine, file: string): StructMemberInfo[] {
  return line.masked
    .split(";")
    .flatMap((statement) => parseStructMemberStatement(statement.trim(), file, line.line, line.raw));
}

function parseStructMemberStatement(
  statement: string,
  file: string,
  line: number,
  raw: string
): StructMemberInfo[] {
  if (!statement || statement.includes("(") || /^(typedef|struct|class|enum)\b/.test(statement)) {
    return [];
  }
  const parts = splitTopLevelCommas(statement);
  const baseTypeName = extractTypeNameFromDeclarator(parts[0] ?? "");
  return parts.flatMap((part, index) => {
    const declarator = part.split("=")[0]?.trim() ?? "";
    const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(declarator);
    if (!nameMatch || isKeyword(nameMatch[1])) {
      return [];
    }
    return [{
      name: nameMatch[1],
      typeName: index === 0 ? baseTypeName : extractTypeNameFromDeclarator(`${baseTypeName ?? ""} ${declarator}`),
      file,
      line,
      declaration: raw.trim(),
      isArray: Boolean(nameMatch[2]),
      pointerLevel: countPointerLevel(declarator)
    }];
  });
}

function parseGlobalStatement(statement: string, file: string, line: number): GlobalVariable[] {
  const normalized = statement.replace(/\s+/g, " ").trim();
  if (!normalized || shouldSkipGlobalStatement(normalized)) {
    return [];
  }
  const isExtern = /\bextern\b/.test(normalized);
  const parts = splitTopLevelCommas(normalized);
  const baseTypeName = extractTypeNameFromDeclarator(parts[0] ?? "");

  return parts.flatMap((part, index) => {
    const declarator = part.split("=")[0]?.trim() ?? "";
    const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(declarator);
    if (!nameMatch || isKeyword(nameMatch[1])) {
      return [];
    }
    const typeName = index === 0
      ? baseTypeName
      : baseTypeName && /^[*&\s]*[A-Za-z_]\w*\s*(?:\[[^\]]*\])?$/.test(declarator)
        ? baseTypeName
        : extractTypeNameFromDeclarator(declarator);
    return [{
      name: nameMatch[1],
      file,
      line,
      declaration: normalized,
      isExtern,
      typeName,
      isArray: Boolean(nameMatch[2]),
      pointerLevel: countPointerLevel(declarator)
    }];
  });
}

function toBodyLine(line: ParserLine): BodyLine {
  return {
    line: line.line,
    raw: line.raw,
    masked: line.masked,
    identifiers: extractIdentifiers(line.masked),
    callIdentifiers: extractCallIdentifiers(line.masked)
  };
}

function extractIdentifiers(line: string): string[] {
  return uniqueMatches(line, /\b[A-Za-z_]\w*\b/g);
}

function extractCallIdentifiers(line: string): string[] {
  return uniqueMatches(line, /\b([A-Za-z_]\w*)\s*\(/g, 1)
    .filter((name) => !SOURCE_CONTROL_KEYWORDS.has(name));
}

function extractFunctionName(signature: string): string | undefined {
  const normalized = signature.replace(/\s+/g, " ").trim();
  if (!normalized || /^(if|for|while|switch|catch|return|sizeof)\b/.test(normalized)) {
    return undefined;
  }
  if (!normalized.includes("(") || !normalized.includes(")") || normalized.includes(";")) {
    return undefined;
  }
  const match = /([~A-Za-z_]\w*(?:::[~A-Za-z_]\w*)?)\s*\([^(){};]*\)\s*(?:const)?\s*$/.exec(normalized);
  return match?.[1];
}

function shouldSkipGlobalStatement(statement: string): boolean {
  return /^#/.test(statement) ||
    /\b(typedef|using|return|goto|break|continue)\b/.test(statement) ||
    /^(if|for|while|switch|catch|struct|class|enum|namespace)\b/.test(statement) ||
    statement.includes("(") ||
    statement.includes(")");
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function extractTypeNameFromDeclarator(declarator: string): string | undefined {
  const withoutInitializer = declarator.split("=")[0]?.trim() ?? "";
  const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*$/.exec(withoutInitializer);
  const prefix = nameMatch ? withoutInitializer.slice(0, nameMatch.index).trim() : withoutInitializer;
  const tokens = prefix
    .replace(/\b(struct|class|enum)\b/g, " ")
    .replace(/[*&]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !DECLARATION_QUALIFIERS.has(token));
  return tokens[tokens.length - 1];
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

function uniqueMatches(line: string, pattern: RegExp, group = 0): string[] {
  const seen = new Set<string>();
  for (const match of line.matchAll(pattern)) {
    const value = match[group];
    if (value) {
      seen.add(value);
    }
  }
  return [...seen];
}

function countPointerLevel(value: string): number {
  return [...value].filter((char) => char === "*").length;
}

function countChar(value: string, char: string): number {
  return [...value].filter((item) => item === char).length;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function location(file: string, line: number, raw: string): SourceLocation {
  return { file, line, text: raw.trim() };
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
