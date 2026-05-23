import * as fs from "node:fs/promises";
import { scanFileStructureWithCustomParser } from "./customParser/customSourceScanner";
import { parseVc6Project } from "./vc6ProjectParser";
import { readThreadMap } from "./threadMap";
import { analyzeFileStructure, buildMemberAnalysisContext, getFileSignature } from "./sourceScanner";
import { scanFileStructures, type ScanFileStructuresResult } from "./workerPool";
import type {
  AnalysisIndex,
  BuildOptions,
  FileAnalysis,
  FileSignature,
  FunctionInfo,
  GlobalVariable,
  MemberSymbol,
  StructTypeInfo,
  ThreadDefinition,
  ThreadReachability
} from "./types";

export async function buildFullIndex(options: BuildOptions): Promise<AnalysisIndex> {
  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs);
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const parserMode = resolveParserMode(options);
  const scanResult = await scanProjectFileStructures(project.sourceFiles, options);
  phaseDurationsMs.structureScan = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const structures = scanResult.structures;
  const globalNames = new Set(structures.flatMap((file) => file.globals.map((global) => global.name)));
  const functionNameMap = buildFunctionNameMap(structures.flatMap((file) => file.functions.map((func) => func.name)));
  const memberContext = buildMemberAnalysisContext(structures);
  phaseDurationsMs.symbolMap = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const files = structures.map((structure) => analyzeFileStructure(structure, globalNames, functionNameMap, memberContext));
  phaseDurationsMs.accessAnalysis = elapsedSince(phaseStarted);

  return composeIndex({
    mode: "full",
    started,
    workspaceRoot: project.workspaceRoot,
    projectFile: project.projectFile,
    projectFiles: project.sourceFiles,
    includePaths: project.includePaths,
    macros: project.macros,
    files,
    threads: threadMap.threads,
    parserMode,
    changedFiles: project.sourceFiles,
    reusedFiles: 0,
    sourceFileCount: project.sourceFiles.length,
    phaseDurationsMs,
    workerCount: scanResult.workerCount
  });
}

export async function updateIndex(
  options: BuildOptions,
  previousIndex: AnalysisIndex | undefined
): Promise<AnalysisIndex> {
  if (!previousIndex) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "previous-index-missing";
    return index;
  }

  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs);
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);
  const projectFilesChanged = !sameStringSet(project.sourceFiles, previousIndex.projectFiles);
  if (projectFilesChanged) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "project-source-list-changed";
    return index;
  }
  const parserMode = resolveParserMode(options);
  if (previousIndex.build.parserMode !== parserMode) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "parser-mode-changed";
    return index;
  }

  const previousFilesByPath = new Map(previousIndex.files.map((file) => [file.file, file]));
  phaseStarted = Date.now();
  const changedFiles = await findChangedFiles(project.sourceFiles, previousFilesByPath);
  phaseDurationsMs.signatureCheck = elapsedSince(phaseStarted);
  if (changedFiles.length === 0) {
    return composeIndex({
      mode: "update",
      started,
      workspaceRoot: project.workspaceRoot,
      projectFile: project.projectFile,
      projectFiles: project.sourceFiles,
      includePaths: project.includePaths,
      macros: project.macros,
      files: previousIndex.files,
      threads: threadMap.threads,
      parserMode,
      changedFiles,
      reusedFiles: previousIndex.files.length,
      sourceFileCount: project.sourceFiles.length,
      phaseDurationsMs: {
        ...phaseDurationsMs,
        structureScan: 0,
        symbolMap: 0,
        accessAnalysis: 0
      },
      workerCount: 0
    });
  }

  phaseStarted = Date.now();
  const scanResult = await scanProjectFileStructures(changedFiles, options);
  const changedStructures = scanResult.structures;
  phaseDurationsMs.structureScan = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const mergedGlobals = mergeSymbolNames(
    previousIndex.files,
    changedStructures.map((structure) => ({
      file: structure.file,
      globals: structure.globals,
      functions: []
    })),
    "globals"
  );
  const mergedFunctions = mergeSymbolNames(
    previousIndex.files,
    changedStructures.map((structure) => ({
      file: structure.file,
      globals: [],
      functions: structure.functions.map((func) => ({ name: func.name }))
    })),
    "functions"
  );
  const changedStructurePaths = new Set(changedStructures.map((structure) => structure.file));
  const mergedSymbolFiles = [
    ...previousIndex.files
      .filter((file) => !changedStructurePaths.has(file.file))
      .map((file) => ({ globals: file.globals, structTypes: file.structTypes })),
    ...changedStructures.map((structure) => ({
      globals: structure.globals,
      structTypes: structure.structTypes
    }))
  ];
  const memberContext = buildMemberAnalysisContext(mergedSymbolFiles);
  const mergedMemberSymbols = new Set(memberContext.memberSymbols.keys());
  const mergedStructSignatures = collectStructTypeSignatures(mergedSymbolFiles);
  phaseDurationsMs.symbolMap = elapsedSince(phaseStarted);

  const previousGlobalNames = new Set(Object.keys(previousIndex.globals));
  const previousFunctionNames = new Set(Object.keys(previousIndex.functions));
  const previousMemberNames = new Set(Object.keys(previousIndex.memberSymbols ?? {}));
  const previousStructSignatures = collectStructTypeSignatures(previousIndex.files);
  if (!sameStringSet([...mergedGlobals], [...previousGlobalNames])) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "global-symbol-set-changed";
    return index;
  }
  if (!sameStringSet([...mergedFunctions], [...previousFunctionNames])) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "function-symbol-set-changed";
    return index;
  }
  if (!sameStringSet([...mergedMemberSymbols], [...previousMemberNames])) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "member-symbol-set-changed";
    return index;
  }
  if (!sameStringSet([...mergedStructSignatures], [...previousStructSignatures])) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "struct-type-set-changed";
    return index;
  }

  const globalNames = previousGlobalNames;
  const functionNameMap = buildFunctionNameMap(previousFunctionNames);
  phaseStarted = Date.now();
  const changedAnalyses = changedStructures.map((structure) =>
    analyzeFileStructure(structure, globalNames, functionNameMap, memberContext)
  );
  phaseDurationsMs.accessAnalysis = elapsedSince(phaseStarted);
  const changedByPath = new Map(changedAnalyses.map((file) => [file.file, file]));
  const files = previousIndex.files.map((file) => changedByPath.get(file.file) ?? file);

  return composeIndex({
    mode: "update",
    started,
    workspaceRoot: project.workspaceRoot,
    projectFile: project.projectFile,
    projectFiles: project.sourceFiles,
    includePaths: project.includePaths,
    macros: project.macros,
    files,
    threads: threadMap.threads,
    parserMode,
    changedFiles,
    reusedFiles: files.length - changedFiles.length,
    sourceFileCount: project.sourceFiles.length,
    phaseDurationsMs,
    workerCount: scanResult.workerCount
  });
}

function composeIndex(args: {
  mode: "full" | "update";
  started: number;
  workspaceRoot: string;
  projectFile: string;
  projectFiles: string[];
  includePaths: string[];
  macros: string[];
  files: FileAnalysis[];
  threads: ThreadDefinition[];
  parserMode: "standard" | "custom";
  changedFiles: string[];
  reusedFiles: number;
  sourceFileCount: number;
  phaseDurationsMs: Record<string, number>;
  workerCount: number;
}): AnalysisIndex {
  const composeStarted = Date.now();
  const globals: Record<string, GlobalVariable[]> = {};
  const memberContext = buildMemberAnalysisContext(args.files);
  const structTypes: Record<string, StructTypeInfo> = {};
  const memberSymbols: Record<string, MemberSymbol[]> = {};
  const functions: Record<string, FunctionInfo> = {};
  const callGraph: Record<string, string[]> = {};
  const calledBy: Record<string, string[]> = {};

  for (const [typeName, typeInfo] of memberContext.structTypes) {
    structTypes[typeName] = typeInfo;
  }
  for (const [memberName, symbols] of memberContext.memberSymbols) {
    memberSymbols[memberName] = symbols;
  }

  for (const file of args.files) {
    for (const global of file.globals) {
      globals[global.name] = [...(globals[global.name] ?? []), global];
    }
    for (const func of file.functions) {
      functions[func.name] = func;
      callGraph[func.name] = func.calls;
      for (const called of func.calls) {
        calledBy[called] = [...(calledBy[called] ?? []), func.name];
      }
    }
  }

  const index: AnalysisIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot: args.workspaceRoot,
    projectFile: args.projectFile,
    projectFiles: args.projectFiles,
    includePaths: args.includePaths,
    macros: args.macros,
    files: args.files,
    globals,
    structTypes,
    memberSymbols,
    functions,
    callGraph,
    calledBy,
    threads: args.threads,
    threadReachability: buildThreadReachability(args.threads, callGraph),
    build: {
      mode: args.mode,
      parserMode: args.parserMode,
      durationMs: Date.now() - args.started,
      phaseDurationsMs: {
        ...args.phaseDurationsMs,
        compose: elapsedSince(composeStarted)
      },
      workerCount: args.workerCount,
      changedFiles: args.changedFiles,
      reusedFiles: args.reusedFiles,
      sourceFileCount: args.sourceFileCount
    }
  };
  index.build.durationMs = Date.now() - args.started;
  return index;
}

async function scanProjectFileStructures(
  files: string[],
  options: BuildOptions
): Promise<ScanFileStructuresResult> {
  if (resolveParserMode(options) !== "custom") {
    return scanFileStructures(files, options.maxIndexWorkers);
  }
  const structures: ScanFileStructuresResult["structures"] = [];
  for (const file of files) {
    structures.push(await scanFileStructureWithCustomParser(file));
  }
  return {
    structures,
    workerCount: 1,
    usedWorkers: false
  };
}

function resolveParserMode(options: BuildOptions): "standard" | "custom" {
  return options.parserMode === "custom" ? "custom" : "standard";
}

function buildThreadReachability(
  threads: ThreadDefinition[],
  callGraph: Record<string, string[]>
): Record<string, ThreadReachability> {
  const reachability: Record<string, ThreadReachability> = {};
  for (const thread of threads) {
    const visited = new Set<string>();
    const stack = [thread.entryFunction];
    while (stack.length > 0) {
      const functionName = stack.pop()!;
      if (visited.has(functionName)) {
        continue;
      }
      visited.add(functionName);
      const current = (reachability[functionName] ??= {
        functionName,
        threadIds: [],
        interruptLikeThreadIds: []
      });
      if (!current.threadIds.includes(thread.threadId)) {
        current.threadIds.push(thread.threadId);
      }
      if (thread.isInterruptLike && !current.interruptLikeThreadIds.includes(thread.threadId)) {
        current.interruptLikeThreadIds.push(thread.threadId);
      }
      for (const called of callGraph[functionName] ?? []) {
        stack.push(called);
      }
    }
  }

  for (const item of Object.values(reachability)) {
    item.threadIds.sort();
    item.interruptLikeThreadIds.sort();
  }
  return reachability;
}

async function findChangedFiles(
  projectFiles: string[],
  previousFilesByPath: Map<string, { signature: FileSignature }>
): Promise<string[]> {
  const checks = await Promise.all(projectFiles.map(async (file) => {
    const previous = previousFilesByPath.get(file);
    if (!previous) {
      return file;
    }
    const current = await getFileSignature(file);
    if (current.size !== previous.signature.size || current.mtimeMs !== previous.signature.mtimeMs) {
      return file;
    }
    return undefined;
  }));
  return checks.filter((file): file is string => Boolean(file)).sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function mergeSymbolNames(
  previousFiles: FileAnalysis[],
  changedFiles: Array<{ file: string; globals: Array<{ name: string }>; functions: Array<{ name: string }> }>,
  key: "globals" | "functions"
): Set<string> {
  const changedPaths = new Set(changedFiles.map((file) => file.file));
  const names = new Set<string>();
  for (const file of previousFiles) {
    if (changedPaths.has(file.file)) {
      continue;
    }
    for (const item of file[key]) {
      names.add(item.name);
    }
  }
  for (const file of changedFiles) {
    for (const item of file[key]) {
      names.add(item.name);
    }
  }
  return names;
}

function collectStructTypeSignatures(
  files: Array<{ structTypes: StructTypeInfo[] }>
): Set<string> {
  const signatures = new Set<string>();
  for (const file of files) {
    for (const structType of file.structTypes ?? []) {
      signatures.add(`${structType.name}:${structType.aliases.join("|")}:${structType.members.map((member) => `${member.name}/${member.typeName ?? ""}/${member.pointerLevel ?? 0}/${member.isArray ? "a" : ""}`).join(",")}`);
    }
  }
  return signatures;
}

export async function assertReadableTargetUnchanged(projectFiles: string[]): Promise<Record<string, FileSignature>> {
  const signatures: Record<string, FileSignature> = {};
  await Promise.all(
    projectFiles.map(async (file) => {
      signatures[file] = await getFileSignature(file);
    })
  );
  return signatures;
}

export async function verifySignaturesUnchanged(
  before: Record<string, FileSignature>
): Promise<{ ok: boolean; changed: string[] }> {
  const changed: string[] = [];
  await Promise.all(
    Object.entries(before).map(async ([file, signature]) => {
      const current = await getFileSignature(file);
      if (current.size !== signature.size || current.mtimeMs !== signature.mtimeMs) {
        changed.push(file);
      }
    })
  );
  return { ok: changed.length === 0, changed: changed.sort() };
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function buildFunctionNameMap(functionNames: Iterable<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const functionName of functionNames) {
    const simpleName = simplifyFunctionName(functionName);
    map.set(simpleName, [...(map.get(simpleName) ?? []), functionName]);
  }
  for (const names of map.values()) {
    names.sort();
  }
  return map;
}

function simplifyFunctionName(functionName: string): string {
  const parts = functionName.split("::");
  return parts[parts.length - 1] ?? functionName;
}

function elapsedSince(started: number): number {
  return Date.now() - started;
}
