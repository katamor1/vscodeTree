import * as path from "node:path";
import { buildMacroAnalysisContext, buildMemberAnalysisContext, getFileSignature, type MacroAnalysisContext, type MemberAnalysisContext } from "../sourceScanner";
import { mapWithConcurrency, normalizeConcurrency } from "../limitedConcurrency";
import { applyConditionalCompilationWithIncludes, type ConditionalIncludeDirective, type ConditionalIncludeFile } from "../preprocessor";
import { readTextFile, type TextEncoding } from "../textEncoding";
import type {
  FileAnalysis,
  FunctionInfo,
  GlobalVariable,
  MacroDefinition,
  ParserDiagnostic,
  StructTypeInfo,
  UnresolvedEvidence,
  VariableAccess
} from "../types";

interface BodyLine {
  line: number;
  raw: string;
  masked: string;
}

interface FunctionStructure {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  bodyLines: BodyLine[];
}

interface FileStructure {
  file: string;
  signature: FileAnalysis["signature"];
  globals: GlobalVariable[];
  structTypes: StructTypeInfo[];
  macroDefinitions: MacroDefinition[];
  functions: FunctionStructure[];
  unresolved: UnresolvedEvidence[];
}

interface TypeScriptContext {
  globalNames: Set<string>;
  functionsBySimpleName: Map<string, string[]>;
  memberContext: MemberAnalysisContext;
  macroContext: MacroAnalysisContext;
  parameterTemplates: Map<string, ParameterTemplate[]>;
}

interface ParameterTemplate {
  parameterIndex: number;
  memberPath: string[];
  kind: "read" | "write" | "unknown";
  memberName?: string;
}

interface MemberExpression {
  expression: string;
  sourceExpression: string;
  start: number;
  end: number;
  ownerName: string;
  connector: "." | "->";
  memberPath: string[];
}

interface PointerAlias {
  ownerName: string;
  connector: "." | "->";
}

export interface TypeScriptAnalysisResult {
  files: FileAnalysis[];
  workerCount: number;
  usedWorkers: boolean;
  diagnostics: ParserDiagnostic[];
  phaseDurationsMs: Record<string, number>;
}

export async function analyzeFilesWithTypeScript(
  files: string[],
  sourceEncoding: TextEncoding = "auto",
  backend: "typescript" | "clang" = "typescript",
  extraDiagnostics: ParserDiagnostic[] = [],
  maxConcurrentFiles = defaultFileConcurrency(),
  macros: string[] = [],
  includePaths: string[] = []
): Promise<TypeScriptAnalysisResult> {
  const started = Date.now();
  const fileConcurrency = normalizeConcurrency(maxConcurrentFiles, files.length);
  const diagnostics: ParserDiagnostic[] = [
    {
      backend,
      severity: "info",
      message: backend === "typescript"
        ? `typescript parser backend completed with lightweight local scanner, file concurrency ${fileConcurrency}`
        : `clang parser backend completed with clang diagnostics plus TypeScript extraction, file concurrency ${fileConcurrency}`
    },
    ...extraDiagnostics
  ];
  const structureStarted = Date.now();
  const structures = await mapWithConcurrency(
    files,
    fileConcurrency,
    (file) => scanFileStructure(file, sourceEncoding, backend, macros, includePaths)
  );
  const structureScan = Date.now() - structureStarted;
  const contextStarted = Date.now();
  const context = buildTypeScriptContext(structures);
  const symbolMap = Date.now() - contextStarted;
  const accessStarted = Date.now();
  const analyses = structures.map((structure) => analyzeStructure(structure, context));
  const accessAnalysis = Date.now() - accessStarted;
  return {
    files: analyses,
    workerCount: 1,
    usedWorkers: false,
    diagnostics,
    phaseDurationsMs: {
      [`${backend}StructureScan`]: structureScan,
      [`${backend}SymbolMap`]: symbolMap,
      [`${backend}AccessAnalysis`]: accessAnalysis,
      [`${backend}FileConcurrency`]: fileConcurrency,
      [`${backend}Total`]: Date.now() - started
    }
  };
}

function defaultFileConcurrency(): number {
  return 8;
}

async function scanFileStructure(
  file: string,
  sourceEncoding: TextEncoding,
  backend: "typescript" | "clang",
  macros: string[],
  includePaths: string[]
): Promise<FileStructure> {
  const decoded = await readTextFile(file, sourceEncoding);
  const signature = await getFileSignature(file);
  const lines = decoded.text.split(/\r?\n/);
  const maskedLines = await applyConditionalCompilationWithIncludes(lines, maskLines(lines), macros, {
    file,
    readIncludeFile: (include, fromFile) => readIncludeFile(include, fromFile, includePaths, sourceEncoding)
  });
  const unresolved: UnresolvedEvidence[] = [];
  if (decoded.lossy) {
    unresolved.push({
      kind: "macro",
      location: { file, line: 1 },
      evidence: "lossy source decode",
      note: `${backend} backend decoded this file with lossy ${decoded.usedEncoding}; review evidence around non-ASCII text.`
    });
  }
  const macroDefinitions = parseMacros(file, lines, maskedLines);
  const structTypes = parseStructTypes(file, maskedLines);
  const functions = parseFunctions(file, lines, maskedLines);
  const globals = parseGlobals(file, maskedLines, functions);
  return { file, signature, globals, structTypes, macroDefinitions, functions, unresolved };
}

async function readIncludeFile(
  include: ConditionalIncludeDirective,
  fromFile: string | undefined,
  includePaths: string[],
  sourceEncoding: TextEncoding
): Promise<ConditionalIncludeFile | undefined> {
  for (const candidate of includeCandidates(include, fromFile, includePaths)) {
    try {
      const decoded = await readTextFile(candidate, sourceEncoding);
      const rawLines = decoded.text.split(/\r?\n/);
      return {
        file: candidate,
        rawLines,
        maskedLines: maskLines(rawLines)
      };
    } catch {
      // Missing include paths are common in partial VC6 workspaces; skip and keep scanning.
    }
  }
  return undefined;
}

function includeCandidates(
  include: ConditionalIncludeDirective,
  fromFile: string | undefined,
  includePaths: string[]
): string[] {
  const candidates: string[] = [];
  if (include.quoted && fromFile) {
    candidates.push(path.resolve(path.dirname(fromFile), include.path));
  }
  candidates.push(...includePaths.map((includePath) => path.resolve(includePath, include.path)));
  return unique(candidates.map((candidate) => candidate.replace(/\\/g, "/")));
}

function buildTypeScriptContext(files: FileStructure[]): TypeScriptContext {
  const globalNames = new Set<string>();
  for (const file of files) {
    for (const global of file.globals) {
      globalNames.add(global.name);
    }
  }
  const summaryFiles = files.map((file) => ({ ...file, functions: [] }));
  const memberContext = buildMemberAnalysisContext(summaryFiles);
  const macroContext = buildMacroAnalysisContext(summaryFiles, globalNames, memberContext);
  const functionsBySimpleName = new Map<string, string[]>();
  const parameterTemplates = new Map<string, ParameterTemplate[]>();
  for (const file of files) {
    for (const func of file.functions) {
      const simple = simplifyFunctionName(func.name);
      functionsBySimpleName.set(simple, [...(functionsBySimpleName.get(simple) ?? []), func.name].sort());
      const templates = buildParameterTemplates(func, macroContext);
      if (templates.length > 0) {
        parameterTemplates.set(func.name, templates);
      }
    }
  }
  return { globalNames, functionsBySimpleName, memberContext, macroContext, parameterTemplates };
}

function analyzeStructure(structure: FileStructure, context: TypeScriptContext): FileAnalysis {
  return {
    file: structure.file,
    signature: structure.signature,
    globals: structure.globals,
    structTypes: structure.structTypes,
    macroDefinitions: structure.macroDefinitions,
    functions: structure.functions.map((func) => analyzeFunction(func, context)),
    unresolved: structure.unresolved
  };
}

function analyzeFunction(func: FunctionStructure, context: TypeScriptContext): FunctionInfo {
  const accesses: VariableAccess[] = [];
  const seenAccesses = new Set<string>();
  const unresolved: UnresolvedEvidence[] = [];
  const calls = new Set<string>();
  const parameterTypes = parseParameterTypes(func.signature);
  const localAliases = new Map<string, PointerAlias>();

  for (const bodyLine of func.bodyLines) {
    const expansion = expandMacroLine(bodyLine.masked, context);
    const masked = expansion.line;
    const raw = bodyLine.raw;
    registerPointerAliases(masked, context, localAliases);
    if (/\b__asm\b/.test(masked)) {
      unresolved.push(unresolvedEvidence("inline-asm", func, bodyLine, undefined, "inline assembly内のメモリアクセスは解析対象外です。"));
    }
    if (/\(\s*\*\s*[A-Za-z_]\w*\s*\)\s*\(/.test(masked)) {
      unresolved.push(unresolvedEvidence("function-pointer", func, bodyLine, undefined, "関数ポインタ呼び出しは呼び出し先を断定していません。"));
    }
    if (/\*\s*[A-Za-z_]\w*\s*=/.test(masked)) {
      unresolved.push(unresolvedEvidence("pointer-write", func, bodyLine, undefined, "ポインタ経由の書き込みは別名先を断定していません。"));
    }

    const memberExpressions = extractMemberExpressions(masked);
    const maskedWithoutMembers = maskMemberExpressions(masked, memberExpressions);
    for (const expression of memberExpressions) {
      const resolved = resolveMemberExpression(expression, context, localAliases, parameterTypes);
      const classified = classifyAccessDetails(masked, expression.sourceExpression);
      if (resolved.targetName) {
        pushAccess(accesses, seenAccesses, {
          variableName: resolved.targetName,
          targetName: resolved.targetName,
          targetKind: "member",
          functionName: func.name,
          kind: classified.kind,
          location: { file: func.file, line: bodyLine.line, text: raw },
          evidence: raw.trim(),
          expandedEvidence: raw.trim() === masked.trim() ? undefined : masked.trim(),
          reasons: classified.reasons,
          ownerName: resolved.ownerName,
          memberName: expression.memberPath.at(-1),
          accessExpression: expression.expression,
          macroNames: expansion.macroNames.length ? expansion.macroNames : undefined
        });
      } else if (resolved.unresolvedName) {
        unresolved.push(unresolvedEvidence("unknown-member-access", func, bodyLine, resolved.unresolvedName, "構造体メンバ参照の実体globalを断定できません。"));
      }
    }

    for (const name of identifiers(maskedWithoutMembers)) {
      if (!context.globalNames.has(name) || !containsWord(maskedWithoutMembers, name)) {
        continue;
      }
      const classified = classifyAccessDetails(maskedWithoutMembers, name);
      const reasons = classified.reasons;
      pushAccess(accesses, seenAccesses, {
        variableName: name,
        targetName: name,
        targetKind: "global",
        functionName: func.name,
        kind: classified.kind,
        location: { file: func.file, line: bodyLine.line, text: raw },
        evidence: raw.trim(),
        expandedEvidence: raw.trim() === masked.trim() ? undefined : masked.trim(),
        reasons,
        macroNames: expansion.macroNames.length ? expansion.macroNames : undefined
      });
      if (reasons.includes("address-taken")) {
        unresolved.push(unresolvedEvidence("address-taken", func, bodyLine, name, "グローバル変数のアドレス取得があり、以降の別名更新は断定していません。"));
      }
    }

    for (const call of directCalls(masked)) {
      const functionNames = context.functionsBySimpleName.get(call.name) ?? [];
      for (const functionName of functionNames) {
        if (functionName !== func.name) {
          calls.add(functionName);
        }
        const templates = context.parameterTemplates.get(functionName) ?? [];
        for (const template of templates) {
          const argument = call.arguments[template.parameterIndex];
          if (!argument) {
            continue;
          }
          const owner = resolveCallArgumentOwner(argument, context, localAliases);
          if (!owner) {
            continue;
          }
          const targetName = `${owner.ownerName}${owner.connector}${template.memberPath.join(".")}`;
          pushAccess(accesses, seenAccesses, {
            variableName: targetName,
            targetName,
            targetKind: "member",
            functionName: func.name,
            kind: template.kind,
            location: { file: func.file, line: bodyLine.line, text: raw },
            evidence: raw.trim(),
            expandedEvidence: raw.trim() === masked.trim() ? undefined : masked.trim(),
            reasons: ["call-argument-alias"],
            ownerName: owner.ownerName,
            memberName: template.memberName,
            accessExpression: argument.trim(),
            macroNames: expansion.macroNames.length ? expansion.macroNames : undefined
          });
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
    calls: Array.from(calls).sort(),
    accesses,
    unresolved
  };
}

function parseMacros(file: string, rawLines: string[], maskedLines: string[]): MacroDefinition[] {
  const result: MacroDefinition[] = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const match = maskedLines[index].match(/^\s*#\s*define\s+([A-Za-z_]\w*)(\s*\(([^)]*)\))?\s*(.*)$/);
    if (!match) {
      continue;
    }
    result.push({
      name: match[1],
      replacement: (match[4] ?? "").trim(),
      file,
      line: index + 1,
      declaration: rawLines[index].trim(),
      isFunctionLike: Boolean(match[2]),
      isObjectLike: !match[2]
    });
  }
  return result;
}

function parseStructTypes(file: string, maskedLines: string[]): StructTypeInfo[] {
  const result: StructTypeInfo[] = [];
  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index];
    if (!/\b(?:typedef\s+)?struct\b/.test(line) || !line.includes("{")) {
      continue;
    }
    const startLine = index + 1;
    const lines = [line];
    let depth = countChar(line, "{") - countChar(line, "}");
    while (depth > 0 && index + 1 < maskedLines.length) {
      index += 1;
      lines.push(maskedLines[index]);
      depth += countChar(maskedLines[index], "{") - countChar(maskedLines[index], "}");
    }
    const block = lines.join("\n");
    const header = lines[0];
    const tag = header.match(/\bstruct\s+([A-Za-z_]\w*)/)?.[1] ?? "";
    const tail = block.slice(block.lastIndexOf("}") + 1).replace(/;/g, " ");
    const aliases = unique(tail.split(/[,\s]+/).map((item) => item.trim()).filter(isIdentifier));
    const name = aliases[0] || tag;
    if (!name) {
      continue;
    }
    result.push({
      name,
      aliases: unique([tag, ...aliases].filter(Boolean)),
      file,
      line: startLine,
      declaration: block.split(/\s+/).join(" ").trim(),
      members: parseStructMembers(file, startLine, block)
    });
  }
  return result;
}

function parseStructMembers(file: string, startLine: number, block: string): StructTypeInfo["members"] {
  const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  return body.split(";").flatMap((statement, offset) => {
    const normalized = statement.split(/\s+/).join(" ").trim();
    if (!normalized || normalized.includes("(")) {
      return [];
    }
    const match = normalized.match(/^(.+?)\s+(\*?\s*[A-Za-z_]\w*)(\s*\[[^\]]+\])?$/);
    if (!match) {
      return [];
    }
    const name = match[2].replace(/\*/g, "").trim();
    if (!isIdentifier(name)) {
      return [];
    }
    return [{
      name,
      typeName: cleanTypeName(match[1]),
      file,
      line: startLine + offset + 1,
      declaration: normalized,
      isArray: Boolean(match[3]),
      pointerLevel: pointerLevelFromParts(match[1], match[2])
    }];
  });
}

function parseFunctions(file: string, rawLines: string[], maskedLines: string[]): FunctionStructure[] {
  const functions: FunctionStructure[] = [];
  let pending = "";
  let pendingStart = 1;
  let active: FunctionStructure | undefined;
  let braceDepth = 0;
  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNo = index + 1;
    const masked = maskedLines[index];
    if (masked.trimStart().startsWith("#")) {
      continue;
    }
    if (active) {
      active.bodyLines.push({ line: lineNo, raw: rawLines[index] ?? "", masked });
      braceDepth += countChar(masked, "{") - countChar(masked, "}");
      if (braceDepth <= 0) {
        active.endLine = lineNo;
        functions.push(active);
        active = undefined;
      }
      continue;
    }
    const trimmed = masked.trim();
    if (!trimmed) {
      continue;
    }
    if (!pending) {
      pendingStart = lineNo;
    }
    pending = `${pending} ${trimmed}`.trim();
    const open = pending.indexOf("{");
    if (open >= 0) {
      const signature = pending.slice(0, open).replace(/\s+/g, " ").trim();
      const name = functionName(signature);
      pending = "";
      if (!name) {
        continue;
      }
      active = {
        name,
        file,
        startLine: pendingStart,
        endLine: lineNo,
        signature,
        bodyLines: [{ line: lineNo, raw: rawLines[index] ?? "", masked }]
      };
      braceDepth = countChar(masked, "{") - countChar(masked, "}");
      if (braceDepth <= 0) {
        functions.push(active);
        active = undefined;
      }
      continue;
    }
    if (pending.includes(";")) {
      pending = "";
    }
  }
  return functions;
}

function parseGlobals(file: string, maskedLines: string[], functions: FunctionStructure[]): GlobalVariable[] {
  const globals: GlobalVariable[] = [];
  const functionRanges = functions.map((func) => [func.startLine, func.endLine]);
  let pending = "";
  let pendingLine = 1;
  let blockDepth = 0;
  for (let index = 0; index < maskedLines.length; index += 1) {
    const lineNo = index + 1;
    const masked = maskedLines[index];
    if (functionRanges.some(([start, end]) => lineNo >= start && lineNo <= end) || masked.trimStart().startsWith("#")) {
      continue;
    }
    const trimmed = masked.trim();
    if (!trimmed) {
      continue;
    }
    if (/\b(?:typedef\s+)?(?:struct|class)\b/.test(trimmed)) {
      blockDepth += countChar(trimmed, "{") - countChar(trimmed, "}");
      continue;
    }
    if (blockDepth > 0) {
      blockDepth += countChar(trimmed, "{") - countChar(trimmed, "}");
      continue;
    }
    if (!pending) {
      pendingLine = lineNo;
    }
    pending = `${pending} ${trimmed}`.trim();
    if (!pending.includes(";")) {
      continue;
    }
    for (const statement of pending.split(";").filter(Boolean)) {
      const normalized = statement.split(/\s+/).join(" ").trim();
      if (!normalized || normalized.includes("(") || /\b(?:return|if|for|while|switch|typedef)\b/.test(normalized)) {
        continue;
      }
      const declarator = normalized.split("=")[0].trim();
      const match = declarator.match(/^(.+?)\s+(\*?\s*[A-Za-z_]\w*)(\s*\[[^\]]+\])?$/);
      if (!match) {
        continue;
      }
      const name = match[2].replace(/\*/g, "").trim();
      if (!isIdentifier(name)) {
        continue;
      }
      globals.push({
        name,
        file,
        line: pendingLine,
        declaration: normalized,
        isExtern: /\bextern\b/.test(normalized),
        typeName: cleanTypeName(match[1]),
        isArray: Boolean(match[3]),
        pointerLevel: pointerLevelFromParts(match[1], match[2])
      });
    }
    pending = "";
  }
  return globals;
}

function buildParameterTemplates(func: FunctionStructure, macroContext: MacroAnalysisContext): ParameterTemplate[] {
  const parameterNames = parseParameterNames(func.signature);
  const indexes = new Map(parameterNames.map((name, index) => [name, index]));
  const result: ParameterTemplate[] = [];
  const seen = new Set<string>();
  for (const line of func.bodyLines) {
    const masked = expandMacroAliases(line.masked, macroContext).line;
    for (const expression of extractMemberExpressions(masked)) {
      const index = indexes.get(expression.ownerName);
      if (index === undefined) {
        continue;
      }
      const key = `${index}:${expression.memberPath.join(".")}:${classifyAccess(masked, expression.sourceExpression)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({
        parameterIndex: index,
        memberPath: expression.memberPath,
        kind: classifyAccess(masked, expression.sourceExpression),
        memberName: expression.memberPath.at(-1)
      });
    }
  }
  return result;
}

function registerPointerAliases(masked: string, context: TypeScriptContext, localAliases: Map<string, PointerAlias>): void {
  const declaration = masked.match(/\b(?:const\s+|volatile\s+)*(?:struct\s+)?([A-Za-z_]\w*)\s*\*\s*([A-Za-z_]\w*)\s*=\s*&?\s*([A-Za-z_]\w*)(?:\s*\[[^\]]+\])?/);
  if (declaration && context.memberContext.globalTypes.has(declaration[3])) {
    localAliases.set(declaration[2], { ownerName: declaration[3], connector: "." });
  }
  const assignment = masked.match(/\b([A-Za-z_]\w*)\s*=\s*&\s*([A-Za-z_]\w*)/);
  if (assignment && context.memberContext.globalTypes.has(assignment[2])) {
    localAliases.set(assignment[1], { ownerName: assignment[2], connector: "." });
  }
}

function resolveMemberExpression(
  expression: MemberExpression,
  context: TypeScriptContext,
  localAliases: Map<string, PointerAlias>,
  parameterTypes: Map<string, string>
): { targetName?: string; ownerName?: string; unresolvedName?: string } {
  const normalizedOwner = expression.ownerName.endsWith("[]") ? expression.ownerName : expression.ownerName;
  const directName = `${normalizedOwner}${expression.connector}${expression.memberPath.join(".")}`;
  const arrayName = `${expression.ownerName}[]${expression.connector}${expression.memberPath.join(".")}`;
  if (context.memberContext.memberSymbols.has(directName)) {
    return { targetName: directName, ownerName: expression.ownerName };
  }
  if (context.memberContext.memberSymbols.has(arrayName)) {
    return { targetName: arrayName, ownerName: `${expression.ownerName}[]` };
  }
  const alias = localAliases.get(expression.ownerName);
  if (alias) {
    const targetName = `${alias.ownerName}${alias.connector}${expression.memberPath.join(".")}`;
    return { targetName, ownerName: alias.ownerName };
  }
  const typeName = parameterTypes.get(expression.ownerName);
  if (typeName) {
    return { unresolvedName: `${typeName}::${expression.memberPath.join(".")}` };
  }
  return {};
}

function resolveCallArgumentOwner(argument: string, context: TypeScriptContext, localAliases: Map<string, PointerAlias>): PointerAlias | undefined {
  const normalized = argument.trim().replace(/^&\s*/, "").replace(/\[[^\]]+\]/g, "[]");
  const memberExpression = extractMemberExpressions(normalized).find((expression) => expression.start === 0 && expression.end === normalized.length);
  if (memberExpression) {
    const resolved = resolveMemberExpression(memberExpression, context, localAliases, new Map());
    if (resolved.targetName) {
      return { ownerName: resolved.targetName, connector: "." };
    }
  }
  if (context.memberContext.globalTypes.has(normalized.replace(/\[\]$/, ""))) {
    return { ownerName: normalized, connector: normalized.endsWith("[]") ? "." : "." };
  }
  return localAliases.get(normalized);
}

function expandMacroLine(line: string, context: TypeScriptContext): { line: string; macroNames: string[] } {
  return expandMacroAliases(line, context.macroContext);
}

function expandMacroAliases(line: string, macroContext: MacroAnalysisContext): { line: string; macroNames: string[] } {
  let expanded = line;
  const macroNames: string[] = [];
  for (let depth = 0; depth < 3; depth += 1) {
    let changed = false;
    for (const [name, aliases] of macroContext.aliases) {
      const alias = aliases[0];
      if (!alias || !containsWord(expanded, name)) {
        continue;
      }
      expanded = replaceWord(expanded, name, alias.replacement);
      macroNames.push(name);
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return { line: expanded, macroNames: unique(macroNames) };
}

function extractMemberExpressions(line: string): MemberExpression[] {
  const result: MemberExpression[] = [];
  const re = /\b([A-Za-z_]\w*)(?:\s*\[[^\]]+\])?\s*(\.|->)\s*([A-Za-z_]\w*(?:\s*\[[^\]]+\])?(?:(?:\s*(?:\.|->)\s*)[A-Za-z_]\w*(?:\s*\[[^\]]+\])?)*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    const sourceExpression = match[0];
    const raw = sourceExpression.replace(/\s+/g, "");
    const ownerName = /\[[^\]]+\]/.test(match[0].slice(0, match[0].indexOf(match[2]))) ? `${match[1]}[]` : match[1];
    result.push({
      expression: raw,
      sourceExpression,
      start: match.index,
      end: match.index + sourceExpression.length,
      ownerName,
      connector: match[2] as "." | "->",
      memberPath: match[3].split(/\.|->/).map(normalizeMemberPathSegment).filter(Boolean)
    });
  }
  return result;
}

function normalizeMemberPathSegment(value: string): string {
  const trimmed = value.trim();
  const name = trimmed.match(/^[A-Za-z_]\w*/)?.[0] ?? "";
  return name && /\[[^\]]+\]/.test(trimmed) ? `${name}[]` : name;
}

function maskMemberExpressions(line: string, expressions: MemberExpression[]): string {
  const chars = line.split("");
  for (const expression of expressions) {
    for (let index = expression.start; index < expression.end; index += 1) {
      chars[index] = " ";
    }
  }
  return chars.join("");
}

function directCalls(line: string): Array<{ name: string; arguments: string[] }> {
  const calls: Array<{ name: string; arguments: string[] }> = [];
  const re = /\b([A-Za-z_]\w*)\s*\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    if (["if", "for", "while", "switch", "return", "sizeof"].includes(match[1])) {
      continue;
    }
    calls.push({ name: match[1], arguments: splitArguments(match[2]) });
  }
  return calls;
}

function classifyAccess(line: string, expression: string): "read" | "write" | "unknown" {
  return classifyAccessDetails(line, expression).kind;
}

function classifyAccessDetails(line: string, expression: string): { kind: "read" | "write" | "unknown"; reasons: string[] } {
  const escaped = escapeRegExp(expression);
  if (new RegExp(`(?:\\+\\+|--)\\s*${escaped}|${escaped}\\s*(?:\\+\\+|--)`).test(line)) {
    return { kind: "write", reasons: ["increment-decrement"] };
  }
  if (new RegExp(`${escaped}\\s*[+\\-*/%&|^]?=`).test(line)) {
    return { kind: "write", reasons: ["assignment"] };
  }
  if (new RegExp(`(^|[^&])&\\s*${escaped}`).test(line)) {
    return { kind: "read", reasons: ["address-taken"] };
  }
  if (containsWord(line, expression)) {
    return { kind: "read", reasons: ["read-reference"] };
  }
  return { kind: "unknown", reasons: [] };
}

function pushAccess(accesses: VariableAccess[], seen: Set<string>, access: VariableAccess): void {
  const key = [
    access.targetKind ?? "",
    access.targetName ?? access.variableName,
    access.kind,
    access.location.file,
    access.location.line,
    access.accessExpression ?? "",
    access.reasons.join(","),
    access.macroNames?.join(",") ?? ""
  ].join("\u001f");
  if (!seen.has(key)) {
    seen.add(key);
    accesses.push(access);
  }
}

function unresolvedEvidence(kind: UnresolvedEvidence["kind"], func: FunctionStructure, line: BodyLine, variableName: string | undefined, note: string): UnresolvedEvidence {
  return {
    kind,
    functionName: func.name,
    variableName,
    location: { file: func.file, line: line.line, text: line.raw },
    evidence: line.raw.trim(),
    note
  };
}

function maskLines(lines: string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    let output = "";
    let index = 0;
    let inString: string | undefined;
    while (index < line.length) {
      const two = line.slice(index, index + 2);
      if (inBlock) {
        if (two === "*/") {
          inBlock = false;
          output += "  ";
          index += 2;
        } else {
          output += " ";
          index += 1;
        }
      } else if (inString) {
        if (line[index] === "\\" && index + 1 < line.length) {
          output += "  ";
          index += 2;
        } else if (line[index] === inString) {
          inString = undefined;
          output += " ";
          index += 1;
        } else {
          output += " ";
          index += 1;
        }
      } else if (two === "/*") {
        inBlock = true;
        output += "  ";
        index += 2;
      } else if (two === "//") {
        output += " ".repeat(line.length - index);
        break;
      } else if (line[index] === "\"" || line[index] === "'") {
        inString = line[index];
        output += " ";
        index += 1;
      } else {
        output += line[index];
        index += 1;
      }
    }
    return output;
  });
}

function parseParameterTypes(signature: string): Map<string, string> {
  const result = new Map<string, string>();
  const inside = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  for (const parameter of splitArguments(inside)) {
    const match = parameter.trim().match(/^(.+?)\s+\*?\s*([A-Za-z_]\w*)$/);
    if (match) {
      result.set(match[2], cleanTypeName(match[1]));
    }
  }
  return result;
}

function parseParameterNames(signature: string): string[] {
  return Array.from(parseParameterTypes(signature).keys());
}

function functionName(signature: string): string | undefined {
  if (/^(?:if|for|while|switch|catch|return|sizeof)\b/.test(signature) || signature.includes(";")) {
    return undefined;
  }
  return signature.match(/(?:^|[\s:*&])([A-Za-z_]\w*)\s*\([^;]*$/)?.[1];
}

function simplifyFunctionName(name: string): string {
  return name.split("::").at(-1) ?? name;
}

function cleanTypeName(value: string): string {
  return value.replace(/\b(?:extern|static|volatile|const|struct|class|typedef)\b/g, " ").replace(/[&*]/g, " ").split(/\s+/).filter(Boolean).at(-1) ?? "";
}

function pointerLevelFromParts(...parts: string[]): number {
  return parts.reduce((count, part) => count + (part.match(/\*/g) ?? []).length, 0);
}

function identifiers(line: string): string[] {
  return unique(Array.from(line.matchAll(/\b[A-Za-z_]\w*\b/g)).map((match) => match[0]));
}

function containsWord(line: string, word: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(word)}([^A-Za-z0-9_]|$)`).test(line);
}

function replaceWord(line: string, word: string, replacement: string): string {
  return line.replace(new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(word)}(?=[^A-Za-z0-9_]|$)`, "g"), `$1${replacement}`);
}

function splitArguments(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function countChar(value: string, char: string): number {
  return [...value].filter((item) => item === char).length;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_]\w*$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
