import * as fs from "node:fs/promises";
import { normalizePath } from "./pathUtils";
import type {
  FileAnalysis,
  FileSignature,
  FunctionInfo,
  GlobalVariable,
  MemberSymbol,
  SourceLocation,
  StructMemberInfo,
  StructTypeInfo,
  UnresolvedEvidence,
  VariableAccess
} from "./types";
import type { BodyLine, FileStructure, FunctionStructure } from "./fileStructure";
export type { BodyLine, FileStructure, FunctionStructure } from "./fileStructure";

interface GlobalTypeInfo {
  global: GlobalVariable;
  type: StructTypeInfo;
}

interface PointerAlias {
  ownerName: string;
  ownerTypeName: string;
  isArrayOwner?: boolean;
  pointerOwner?: boolean;
}

interface LocalTypeInfo {
  typeName: string;
  pointerLevel: number;
}

interface MemberExpression {
  expression: string;
  ownerName: string;
  ownerIndexed: boolean;
  firstConnector: "." | "->";
  memberPath: string[];
  start: number;
  end: number;
}

export interface MemberAnalysisContext {
  structTypes: Map<string, StructTypeInfo>;
  globalTypes: Map<string, GlobalTypeInfo>;
  memberSymbols: Map<string, MemberSymbol[]>;
  knownTypeNames: Set<string>;
  knownMemberNames: Set<string>;
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
  const structTypes = parseStructTypes(rawLines, maskedLines, normalizedFile);
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
      activeFunction.bodyLines.push(toBodyLine(lineNumber, raw, masked));
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
          bodyLines: [toBodyLine(lineNumber, raw, masked)]
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
    structTypes,
    functions,
    unresolved
  };
}

export function buildMemberAnalysisContext(
  files: Array<Pick<FileStructure | FileAnalysis, "globals" | "structTypes">>
): MemberAnalysisContext {
  const structTypes = new Map<string, StructTypeInfo>();
  const knownMemberNames = new Set<string>();
  for (const file of files) {
    for (const structType of file.structTypes ?? []) {
      for (const typeName of [structType.name, ...structType.aliases]) {
        if (typeName && !structTypes.has(typeName)) {
          structTypes.set(typeName, structType);
        }
      }
      for (const member of structType.members) {
        knownMemberNames.add(member.name);
      }
    }
  }

  const globalTypes = new Map<string, GlobalTypeInfo>();
  for (const file of files) {
    for (const global of file.globals) {
      const typeName = global.typeName;
      const type = typeName ? structTypes.get(typeName) : undefined;
      if (typeName && type) {
        globalTypes.set(global.name, { global, type });
      }
    }
  }

  const memberSymbols = new Map<string, MemberSymbol[]>();
  for (const { global, type } of globalTypes.values()) {
    for (const symbol of buildMemberSymbolsForGlobal(global, type, structTypes)) {
      memberSymbols.set(symbol.name, [...(memberSymbols.get(symbol.name) ?? []), symbol]);
    }
  }

  return {
    structTypes,
    globalTypes,
    memberSymbols,
    knownTypeNames: new Set(structTypes.keys()),
    knownMemberNames
  };
}

function buildMemberSymbolsForGlobal(
  global: GlobalVariable,
  type: StructTypeInfo,
  structTypes: Map<string, StructTypeInfo>
): MemberSymbol[] {
  const ownerName = global.isArray ? `${global.name}[]` : global.name;
  const firstSeparator = (global.pointerLevel ?? 0) > 0 ? "->" : ".";
  const symbols: MemberSymbol[] = [];
  appendMemberSymbols({
    symbols,
    ownerName,
    ownerTypeName: type.name,
    file: global.file,
    line: global.line,
    declarationPrefix: global.declaration,
    pathPrefix: "",
    separator: firstSeparator,
    type,
    structTypes,
    isArrayOwner: global.isArray,
    pointerOwner: (global.pointerLevel ?? 0) > 0,
    depth: 0
  });
  return symbols;
}

function appendMemberSymbols(args: {
  symbols: MemberSymbol[];
  ownerName: string;
  ownerTypeName: string;
  file: string;
  line: number;
  declarationPrefix: string;
  pathPrefix: string;
  separator: "." | "->";
  type: StructTypeInfo;
  structTypes: Map<string, StructTypeInfo>;
  isArrayOwner?: boolean;
  pointerOwner?: boolean;
  depth: number;
}): void {
  if (args.depth > 2) {
    return;
  }
  for (const member of args.type.members) {
    const memberPath = args.pathPrefix ? `${args.pathPrefix}.${member.name}` : member.name;
    const name = `${args.ownerName}${args.separator}${memberPath}`;
    args.symbols.push({
      name,
      ownerName: args.ownerName,
      ownerTypeName: args.ownerTypeName,
      memberName: member.name,
      memberPath: memberPath.split("."),
      file: args.file,
      line: args.line,
      declaration: `${args.declarationPrefix} :: ${member.declaration}`,
      isArrayOwner: args.isArrayOwner,
      pointerOwner: args.pointerOwner
    });
    const nestedType = member.typeName ? args.structTypes.get(member.typeName) : undefined;
    if (nestedType && (member.pointerLevel ?? 0) === 0) {
      appendMemberSymbols({
        ...args,
        pathPrefix: memberPath,
        separator: args.separator,
        type: nestedType,
        depth: args.depth + 1
      });
    }
  }
}

function parseStructTypes(rawLines: string[], maskedLines: string[], file: string): StructTypeInfo[] {
  const result: StructTypeInfo[] = [];
  let active: { startLine: number; masked: string[]; raw: string[]; braceDepth: number } | undefined;

  for (let index = 0; index < maskedLines.length; index += 1) {
    const masked = maskedLines[index] ?? "";
    const raw = rawLines[index] ?? "";
    const trimmed = masked.trim();

    if (!active) {
      if (!/\b(?:typedef\s+)?(?:struct|class)\b/.test(trimmed) || !trimmed.includes("{")) {
        continue;
      }
      active = {
        startLine: index + 1,
        masked: [masked],
        raw: [raw],
        braceDepth: countChar(masked, "{") - countChar(masked, "}")
      };
      if (active.braceDepth > 0 || !trimmed.includes(";")) {
        continue;
      }
    } else {
      active.masked.push(masked);
      active.raw.push(raw);
      active.braceDepth += countChar(masked, "{") - countChar(masked, "}");
      if (active.braceDepth > 0 || !trimmed.includes(";")) {
        continue;
      }
    }

    const parsed = parseStructBlock(active.masked.join("\n"), active.raw.join("\n"), file, active.startLine);
    if (parsed) {
      result.push(parsed);
    }
    active = undefined;
  }

  return result;
}

function parseStructBlock(maskedBlock: string, rawBlock: string, file: string, line: number): StructTypeInfo | undefined {
  const open = maskedBlock.indexOf("{");
  const close = maskedBlock.lastIndexOf("}");
  if (open < 0 || close <= open) {
    return undefined;
  }
  const header = maskedBlock.slice(0, open).replace(/\s+/g, " ").trim();
  const body = maskedBlock.slice(open + 1, close);
  const tail = maskedBlock.slice(close + 1).replace(/;.*$/s, "").trim();
  const tagName = /\b(?:struct|class)\s+([A-Za-z_]\w*)/.exec(header)?.[1];
  const typedefAliases = /^\s*typedef\b/.test(header) ? extractTypedefAliases(tail) : [];
  const aliases = [...new Set([...(tagName ? [tagName] : []), ...typedefAliases])];
  const name = typedefAliases[0] ?? tagName;
  if (!name) {
    return undefined;
  }

  return {
    name,
    aliases,
    file,
    line,
    declaration: rawBlock.split(/\r?\n/)[0]?.trim() ?? header,
    members: parseStructMembers(body, file, line)
  };
}

function extractTypedefAliases(tail: string): string[] {
  const aliases: string[] = [];
  for (const part of splitTopLevelCommas(tail)) {
    const withoutInitializer = part.split("=")[0]?.trim() ?? "";
    const match = /\*?\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/.exec(withoutInitializer);
    if (match && !isKeyword(match[1])) {
      aliases.push(match[1]);
    }
  }
  return aliases;
}

function parseStructMembers(body: string, file: string, startLine: number): StructMemberInfo[] {
  const members: StructMemberInfo[] = [];
  const statements = body.split(";");
  let lineOffset = 0;
  for (const statement of statements) {
    const statementLine = startLine + lineOffset;
    lineOffset += countChar(statement, "\n");
    const normalized = statement
      .replace(/\b(public|private|protected)\s*:/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || shouldSkipMemberStatement(normalized)) {
      continue;
    }
    const parts = splitTopLevelCommas(normalized);
    const baseTypeName = extractTypeNameFromDeclarator(parts[0]?.trim() ?? "");
    for (const [partIndex, part] of parts.entries()) {
      const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(?::\s*\d+)?$/.exec(part.trim());
      if (!nameMatch || isKeyword(nameMatch[1])) {
        continue;
      }
      members.push({
        name: nameMatch[1],
        typeName: partIndex === 0 ? baseTypeName : baseTypeName,
        file,
        line: statementLine,
        declaration: normalized,
        isArray: Boolean(nameMatch[2]),
        pointerLevel: countPointerLevel(part)
      });
    }
  }
  return members;
}

function shouldSkipMemberStatement(statement: string): boolean {
  if (/\b(union|struct|class|enum)\b.*\{/.test(statement)) {
    return true;
  }
  if (statement.includes("(") || statement.includes(")")) {
    return true;
  }
  return false;
}

export function analyzeFileStructure(
  structure: FileStructure,
  globalNames: Set<string>,
  functionNameMap: Map<string, string[]> | Record<string, string[]>,
  memberContext = buildMemberAnalysisContext([structure])
): FileAnalysis {
  const functions = structure.functions.map((func) =>
    analyzeFunction(func, globalNames, functionNameMap, memberContext)
  );
  return {
    file: structure.file,
    signature: structure.signature,
    globals: structure.globals,
    structTypes: structure.structTypes,
    functions,
    unresolved: structure.unresolved
  };
}

function analyzeFunction(
  func: FunctionStructure,
  globalNames: Set<string>,
  functionNameMap: Map<string, string[]> | Record<string, string[]>,
  memberContext: MemberAnalysisContext
): FunctionInfo {
  const accesses: VariableAccess[] = [];
  const unresolved: UnresolvedEvidence[] = [];
  const calls = new Set<string>();
  const localTypes = parseFunctionParameterTypes(func.signature, memberContext);
  const pointerAliases = new Map<string, PointerAlias>();
  const ambiguousAliases = new Set<string>();

  for (const bodyLine of func.bodyLines) {
    const masked = bodyLine.masked;
    const raw = bodyLine.raw;
    registerLocalTypesAndAliases(masked, memberContext, localTypes, pointerAliases, ambiguousAliases);
    const memberExpressions = extractMemberExpressions(masked);
    const maskedWithoutMembers = maskRanges(masked, memberExpressions);
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

    for (const expression of memberExpressions) {
      const resolved = resolveMemberExpression(expression, memberContext, localTypes, pointerAliases, ambiguousAliases);
      if (!resolved) {
        continue;
      }
      const { kind, reasons } = classifyAccess(masked, expression.expression);
      if (resolved.accessTargetName) {
        accesses.push({
          variableName: resolved.accessTargetName,
          targetName: resolved.accessTargetName,
          targetKind: "member",
          functionName: func.name,
          kind,
          location: location(func.file, bodyLine.line, raw),
          evidence: raw.trim(),
          reasons,
          ownerName: resolved.ownerName,
          memberName: resolved.memberName,
          accessExpression: expression.expression
        });
      }
      if (reasons.includes("address-taken") && resolved.accessTargetName) {
        unresolved.push({
          kind: "address-taken",
          functionName: func.name,
          variableName: resolved.accessTargetName,
          location: location(func.file, bodyLine.line, raw),
          evidence: raw.trim(),
          note: "構造体メンバのアドレス取得があり、以降の別名更新は断定していません。"
        });
      }
      if (resolved.unresolvedKind) {
        unresolved.push({
          kind: resolved.unresolvedKind,
          functionName: func.name,
          variableName: resolved.unresolvedName,
          location: location(func.file, bodyLine.line, raw),
          evidence: raw.trim(),
          note: resolved.unresolvedNote
        });
      }
    }

    for (const variableName of bodyLine.identifiers) {
      if (!globalNames.has(variableName)) {
        continue;
      }
      if (!containsWord(maskedWithoutMembers, variableName)) {
        continue;
      }
      const { kind, reasons } = classifyAccess(maskedWithoutMembers, variableName);
      accesses.push({
        variableName,
        targetName: variableName,
        targetKind: "global",
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

    for (const simpleName of bodyLine.callIdentifiers) {
      for (const functionName of lookupFunctionNames(functionNameMap, simpleName)) {
        if (functionName !== func.name) {
          calls.add(functionName);
        }
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
  const declarationParts = splitTopLevelCommas(normalized);
  const firstDeclarator = declarationParts[0]?.split("=")[0]?.trim() ?? "";
  const baseTypeName = extractTypeNameFromDeclarator(firstDeclarator);

  for (const [partIndex, rawPart] of declarationParts.entries()) {
    const beforeInitializer = rawPart.split("=")[0]?.trim() ?? "";
    const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$/.exec(beforeInitializer);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1];
    if (isKeyword(name)) {
      continue;
    }
    const typeName = partIndex === 0
      ? baseTypeName
      : baseTypeName && /^[*&\s]*[A-Za-z_]\w*\s*(?:\[[^\]]*\])?$/.test(beforeInitializer)
        ? baseTypeName
        : extractTypeNameFromDeclarator(beforeInitializer);
    result.push({
      name,
      file: source.file,
      line: source.line,
      declaration: normalized,
      isExtern,
      typeName,
      isArray: Boolean(nameMatch[2]),
      pointerLevel: countPointerLevel(beforeInitializer.slice(0, nameMatch.index + nameMatch[0].length))
    });
  }
  return result;
}

function parseFunctionParameterTypes(
  signature: string,
  context: MemberAnalysisContext
): Map<string, LocalTypeInfo> {
  const localTypes = new Map<string, LocalTypeInfo>();
  const params = /\((.*)\)/.exec(signature)?.[1];
  if (!params || params.trim() === "void") {
    return localTypes;
  }
  for (const param of splitTopLevelCommas(params)) {
    const parsed = parseTypedDeclarator(param, context);
    if (parsed) {
      localTypes.set(parsed.name, { typeName: parsed.typeName, pointerLevel: parsed.pointerLevel });
    }
  }
  return localTypes;
}

function registerLocalTypesAndAliases(
  line: string,
  context: MemberAnalysisContext,
  localTypes: Map<string, LocalTypeInfo>,
  pointerAliases: Map<string, PointerAlias>,
  ambiguousAliases: Set<string>
): void {
  const statements = line.split(";");
  for (const statement of statements) {
    const parsed = parseTypedDeclarator(statement, context);
    if (parsed) {
      localTypes.set(parsed.name, { typeName: parsed.typeName, pointerLevel: parsed.pointerLevel });
      if (parsed.pointerLevel > 0 && parsed.initializer) {
        setPointerAliasFromInitializer(parsed.name, parsed.initializer, parsed.typeName, context, pointerAliases, ambiguousAliases);
      }
    }
  }

  for (const [name, localType] of localTypes) {
    if (localType.pointerLevel <= 0) {
      continue;
    }
    const assignment = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*([^;]+)`).exec(line);
    if (assignment?.[1] && !new RegExp(`\\b(?:struct\\s+)?${escapeRegExp(localType.typeName)}\\b`).test(line.slice(0, assignment.index))) {
      setPointerAliasFromInitializer(name, assignment[1], localType.typeName, context, pointerAliases, ambiguousAliases);
    }
  }
}

function parseTypedDeclarator(
  text: string,
  context: MemberAnalysisContext
): { name: string; typeName: string; pointerLevel: number; initializer?: string } | undefined {
  const beforeSemicolon = text.split(";")[0]?.trim() ?? "";
  if (!beforeSemicolon) {
    return undefined;
  }
  for (const typeName of [...context.knownTypeNames].sort((left, right) => right.length - left.length)) {
    const match = new RegExp(
      `(?:^|\\s)(?:const\\s+|volatile\\s+|static\\s+|register\\s+)*(?:struct\\s+|class\\s+)?${escapeRegExp(typeName)}\\s*(\\*+)?\\s*([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*(?:=\\s*(.+))?$`
    ).exec(beforeSemicolon);
    if (match?.[2]) {
      return {
        name: match[2],
        typeName,
        pointerLevel: match[1]?.length ?? 0,
        initializer: match[3]?.trim()
      };
    }
  }
  return undefined;
}

function setPointerAliasFromInitializer(
  pointerName: string,
  initializer: string,
  expectedTypeName: string,
  context: MemberAnalysisContext,
  pointerAliases: Map<string, PointerAlias>,
  ambiguousAliases: Set<string>
): void {
  const resolved = resolvePointerInitializer(initializer, expectedTypeName, context, pointerAliases);
  if (!resolved) {
    pointerAliases.delete(pointerName);
    ambiguousAliases.add(pointerName);
    return;
  }
  const existing = pointerAliases.get(pointerName);
  if (existing && aliasKey(existing) !== aliasKey(resolved)) {
    pointerAliases.delete(pointerName);
    ambiguousAliases.add(pointerName);
    return;
  }
  if (!ambiguousAliases.has(pointerName)) {
    pointerAliases.set(pointerName, resolved);
  }
}

function resolvePointerInitializer(
  initializer: string,
  expectedTypeName: string,
  context: MemberAnalysisContext,
  pointerAliases: Map<string, PointerAlias>
): PointerAlias | undefined {
  const value = initializer.trim().replace(/\s+/g, " ");
  if (/^(0|NULL|nullptr)$/.test(value)) {
    return undefined;
  }
  const address = /^&\s*([A-Za-z_]\w*)\s*(?:\[[^\]]+\])?$/.exec(value);
  if (address?.[1]) {
    const globalType = context.globalTypes.get(address[1]);
    if (globalType && typeMatches(globalType.global.typeName, expectedTypeName)) {
      return {
        ownerName: globalType.global.isArray || /\[[^\]]+\]/.test(value) ? `${address[1]}[]` : address[1],
        ownerTypeName: globalType.global.typeName ?? expectedTypeName,
        isArrayOwner: globalType.global.isArray || /\[[^\]]+\]/.test(value)
      };
    }
  }
  const sourceName = /^([A-Za-z_]\w*)$/.exec(value)?.[1];
  if (sourceName) {
    const copied = pointerAliases.get(sourceName);
    if (copied) {
      return copied;
    }
    const globalType = context.globalTypes.get(sourceName);
    if (globalType && (globalType.global.pointerLevel ?? 0) > 0 && typeMatches(globalType.global.typeName, expectedTypeName)) {
      return {
        ownerName: sourceName,
        ownerTypeName: globalType.global.typeName ?? expectedTypeName,
        pointerOwner: true
      };
    }
  }
  return undefined;
}

function extractMemberExpressions(line: string): MemberExpression[] {
  const expressions: MemberExpression[] = [];
  const pattern = /\b([A-Za-z_]\w*)(\s*\[[^\]]*\])?\s*((?:(?:\.|->)\s*[A-Za-z_]\w*(?:\s*\[[^\]]*\])?\s*)+)/g;
  for (const match of line.matchAll(pattern)) {
    if (match.index === undefined || !match[0] || !match[3]) {
      continue;
    }
    const segments = [...match[3].matchAll(/(\.|->)\s*([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?/g)];
    if (segments.length === 0) {
      continue;
    }
    expressions.push({
      expression: match[0].trim(),
      ownerName: match[1],
      ownerIndexed: Boolean(match[2]),
      firstConnector: segments[0]![1] as "." | "->",
      memberPath: segments.map((segment) => segment[2]).filter(Boolean),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return expressions;
}

function resolveMemberExpression(
  expression: MemberExpression,
  context: MemberAnalysisContext,
  localTypes: Map<string, LocalTypeInfo>,
  pointerAliases: Map<string, PointerAlias>,
  ambiguousAliases: Set<string>
): {
  accessTargetName?: string;
  ownerName?: string;
  memberName?: string;
  unresolvedKind?: "unknown-member-access" | "ambiguous-member-alias";
  unresolvedName?: string;
  unresolvedNote: string;
} | undefined {
  if (expression.firstConnector === ".") {
    const globalType = context.globalTypes.get(expression.ownerName);
    if (!globalType || (globalType.global.pointerLevel ?? 0) > 0) {
      return undefined;
    }
    const ownerName = globalType.global.isArray || expression.ownerIndexed ? `${expression.ownerName}[]` : expression.ownerName;
    const targetName = canonicalMemberName(ownerName, ".", expression.memberPath);
    if (!memberPathExists(globalType.type, expression.memberPath, context.structTypes)) {
      return {
        ownerName,
        memberName: expression.memberPath[expression.memberPath.length - 1],
        unresolvedKind: "unknown-member-access",
        unresolvedName: targetName,
        unresolvedNote: "global構造体のメンバ名を型表から確認できません。"
      };
    }
    return {
      accessTargetName: targetName,
      ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedNote: ""
    };
  }

  if (ambiguousAliases.has(expression.ownerName)) {
    return {
      ownerName: expression.ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedKind: "ambiguous-member-alias",
      unresolvedName: canonicalMemberName(expression.ownerName, "->", expression.memberPath),
      unresolvedNote: "ポインタ別名の代入先が複数候補になったため、メンバ更新先を断定していません。"
    };
  }

  const alias = pointerAliases.get(expression.ownerName);
  if (alias) {
    const separator = alias.pointerOwner ? "->" : ".";
    const targetName = canonicalMemberName(alias.ownerName, separator, expression.memberPath);
    return {
      accessTargetName: targetName,
      ownerName: alias.ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedNote: ""
    };
  }

  const globalType = context.globalTypes.get(expression.ownerName);
  if (globalType && (globalType.global.pointerLevel ?? 0) > 0) {
    return {
      accessTargetName: canonicalMemberName(expression.ownerName, "->", expression.memberPath),
      ownerName: expression.ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedNote: ""
    };
  }

  const localType = localTypes.get(expression.ownerName);
  if (localType?.typeName) {
    return {
      accessTargetName: canonicalTypeMemberName(localType.typeName, expression.memberPath),
      ownerName: expression.ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedKind: "unknown-member-access",
      unresolvedName: canonicalTypeMemberName(localType.typeName, expression.memberPath),
      unresolvedNote: "型は推定できましたが、ポインタ引数または局所ポインタの参照先globalを一意に断定していません。"
    };
  }

  if (context.knownMemberNames.has(expression.memberPath[expression.memberPath.length - 1] ?? "")) {
    return {
      ownerName: expression.ownerName,
      memberName: expression.memberPath[expression.memberPath.length - 1],
      unresolvedKind: "unknown-member-access",
      unresolvedName: canonicalMemberName(expression.ownerName, "->", expression.memberPath),
      unresolvedNote: "ポインタの型と参照先を静的に断定していません。"
    };
  }
  return undefined;
}

function memberPathExists(
  type: StructTypeInfo,
  memberPath: string[],
  structTypes: Map<string, StructTypeInfo>
): boolean {
  let currentType: StructTypeInfo | undefined = type;
  for (const [index, memberName] of memberPath.entries()) {
    const member: StructMemberInfo | undefined = currentType?.members.find((item) => item.name === memberName);
    if (!member) {
      return false;
    }
    if (index < memberPath.length - 1) {
      currentType = member.typeName ? structTypes.get(member.typeName) : undefined;
      if (!currentType) {
        return false;
      }
    }
  }
  return true;
}

function canonicalMemberName(ownerName: string, separator: "." | "->", memberPath: string[]): string {
  return `${ownerName}${separator}${memberPath.join(".")}`;
}

function canonicalTypeMemberName(typeName: string, memberPath: string[]): string {
  return `${typeName}::${memberPath.join(".")}`;
}

function maskRanges(line: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) {
    return line;
  }
  const chars = [...line];
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      chars[index] = " ";
    }
  }
  return chars.join("");
}

function toBodyLine(line: number, raw: string, masked: string): BodyLine {
  return {
    line,
    raw,
    masked,
    identifiers: extractIdentifiers(masked),
    callIdentifiers: extractCallIdentifiers(masked)
  };
}

export function extractIdentifiers(line: string): string[] {
  return uniqueMatches(line, /\b[A-Za-z_]\w*\b/g);
}

export function extractCallIdentifiers(line: string): string[] {
  const calls = uniqueMatches(line, /\b([A-Za-z_]\w*)\s*\(/g, 1);
  return calls.filter((name) => !CONTROL_KEYWORDS.has(name));
}

function lookupFunctionNames(
  functionNameMap: Map<string, string[]> | Record<string, string[]>,
  simpleName: string
): string[] {
  return functionNameMap instanceof Map
    ? functionNameMap.get(simpleName) ?? []
    : functionNameMap[simpleName] ?? [];
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

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    } else if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function extractTypeNameFromDeclarator(declarator: string): string | undefined {
  const withoutInitializer = declarator.split("=")[0]?.trim() ?? "";
  const nameMatch = /(?:\*|\s|^)([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?::\s*\d+)?$/.exec(withoutInitializer);
  const prefix = nameMatch
    ? withoutInitializer.slice(0, nameMatch.index).trim()
    : withoutInitializer;
  const candidates = prefix
    .replace(/\b(const|volatile|static|extern|register|auto|signed|unsigned|long|short)\b/g, " ")
    .replace(/\b(struct|class)\b/g, " ")
    .replace(/[*&]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return candidates[candidates.length - 1];
}

function countPointerLevel(value: string): number {
  return [...value].filter((char) => char === "*").length;
}

function containsWord(line: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(line);
}

function typeMatches(actual: string | undefined, expected: string): boolean {
  return actual === expected;
}

function aliasKey(alias: PointerAlias): string {
  return `${alias.ownerName}:${alias.ownerTypeName}:${alias.isArrayOwner ? "array" : ""}:${alias.pointerOwner ? "ptr" : ""}`;
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
  if (new RegExp(`(^|[^&])&\\s*${escaped}\\b`).test(line)) {
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

function simplifyFunctionName(functionName: string): string {
  const parts = functionName.split("::");
  return parts[parts.length - 1] ?? functionName;
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof"
]);

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
