import * as fs from "node:fs/promises";
import { parseVc6Project } from "./vc6ProjectParser";
import { readThreadMap } from "./threadMap";
import { buildMacroAnalysisContext, buildMemberAnalysisContext, getFileSignature } from "./sourceScanner";
import { analyzeFilesWithParserBackend } from "./parserBackend";
import type {
  AnalysisIndex,
  BuildOptions,
  FileAnalysis,
  FileSignature,
  FunctionInfo,
  GlobalVariable,
  MacroAlias,
  MacroDefinition,
  MemberSymbol,
  ParserDiagnostic,
  StructTypeInfo,
  ThreadDefinition,
  ThreadReachability
} from "./types";

export async function buildFullIndex(options: BuildOptions): Promise<AnalysisIndex> {
  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  const parserEngine = options.parserEngine ?? "rust";
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto");
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const scanResult = await analyzeFilesWithParserBackend({
    parserEngine,
    files: project.sourceFiles,
    maxIndexWorkers: options.maxIndexWorkers,
    maxNativeBatchFiles: options.maxNativeBatchFiles,
    sourceEncoding: options.sourceEncoding ?? "auto",
    includePaths: project.includePaths,
    macros: project.macros
  });
  phaseDurationsMs.structureScan = elapsedSince(phaseStarted);
  Object.assign(phaseDurationsMs, scanResult.phaseDurationsMs);
  phaseDurationsMs.symbolMap = scanResult.phaseDurationsMs[`${parserEngine}SymbolMap`] ?? scanResult.phaseDurationsMs.rustSymbolMap ?? 0;
  phaseDurationsMs.accessAnalysis = scanResult.phaseDurationsMs[`${parserEngine}AccessAnalysis`] ?? scanResult.phaseDurationsMs.rustAccessAnalysis ?? 0;

  return composeIndex({
    mode: "full",
    started,
    workspaceRoot: project.workspaceRoot,
    projectFile: project.projectFile,
    projectFiles: project.sourceFiles,
    includePaths: project.includePaths,
    macros: project.macros,
    files: scanResult.files,
    threads: threadMap.threads,
    changedFiles: project.sourceFiles,
    reusedFiles: 0,
    sourceFileCount: project.sourceFiles.length,
    parserEngine,
    phaseDurationsMs,
    workerCount: scanResult.workerCount,
    parserDiagnostics: scanResult.diagnostics
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
  const parserEngine = options.parserEngine ?? "rust";
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto");
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);

  if (!sameStringSet(project.sourceFiles, previousIndex.projectFiles)) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "project-source-list-changed";
    return index;
  }

  if (previousIndex.build.parserMode !== parserEngine) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "parser-engine-changed";
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
      changedFiles,
      reusedFiles: previousIndex.files.length,
      sourceFileCount: project.sourceFiles.length,
      parserEngine,
      phaseDurationsMs: {
        ...phaseDurationsMs,
        structureScan: 0,
        symbolMap: 0,
        accessAnalysis: 0
      },
      workerCount: 0,
      parserDiagnostics: previousIndex.parserDiagnostics ?? []
    });
  }

  const index = await buildFullIndex(options);
  index.build.mode = "update";
  index.build.changedFiles = changedFiles;
  index.build.reusedFiles = 0;
  index.build.fullRebuildReason = parserEngine === "rust"
    ? "rust-native-update-rebuild"
    : `${parserEngine}-update-rebuild`;
  return index;
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
  changedFiles: string[];
  reusedFiles: number;
  sourceFileCount: number;
  parserEngine: AnalysisIndex["build"]["parserMode"];
  phaseDurationsMs: Record<string, number>;
  workerCount: number;
  parserDiagnostics: ParserDiagnostic[];
}): AnalysisIndex {
  const composeStarted = Date.now();
  const globals: Record<string, GlobalVariable[]> = {};
  const memberContext = buildMemberAnalysisContext(args.files);
  const globalNames = new Set<string>();
  for (const file of args.files) {
    for (const global of file.globals) {
      globalNames.add(global.name);
    }
  }
  const macroContext = buildMacroAnalysisContext(args.files, globalNames, memberContext);
  const structTypes: Record<string, StructTypeInfo> = {};
  const memberSymbols: Record<string, MemberSymbol[]> = {};
  const macroDefinitions: Record<string, MacroDefinition[]> = {};
  const macroAliases: Record<string, MacroAlias[]> = {};
  const functions: Record<string, FunctionInfo> = {};
  const callGraph: Record<string, string[]> = {};
  const calledBy: Record<string, string[]> = {};

  for (const [typeName, typeInfo] of memberContext.structTypes) {
    structTypes[typeName] = typeInfo;
  }
  for (const [memberName, symbols] of memberContext.memberSymbols) {
    memberSymbols[memberName] = symbols;
  }
  for (const [macroName, definitions] of macroContext.definitions) {
    macroDefinitions[macroName] = definitions;
  }
  for (const [macroName, aliases] of macroContext.aliases) {
    macroAliases[macroName] = aliases;
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
    macroDefinitions,
    macroAliases,
    parserDiagnostics: args.parserDiagnostics,
    functions,
    callGraph,
    calledBy,
    threads: args.threads,
    threadReachability: buildThreadReachability(args.threads, callGraph),
    build: {
      mode: args.mode,
      parserMode: args.parserEngine,
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

function elapsedSince(started: number): number {
  return Date.now() - started;
}
