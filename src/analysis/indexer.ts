import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseVc6Project } from "./vc6ProjectParser";
import { readThreadMap } from "./threadMap";
import { buildMacroAnalysisContext, buildMemberAnalysisContext, getFileSignature } from "./sourceScanner";
import { analyzeFilesWithParserBackend } from "./parserBackend";
import { mapWithConcurrency } from "./limitedConcurrency";
import { parseRustOutputFile, runRustAnalyzeManyToOutputWithAutoSkip, rustPhaseDurations } from "./rust/rustSourceScanner";
import { createIndexFunctionWriter, writeIndex } from "./store";
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
  SkippedSourceFile,
  StructTypeInfo,
  ThreadDefinition,
  ThreadReachability
} from "./types";

const SIGNATURE_CHECK_CONCURRENCY = 64;

type SummaryFile = Pick<FileAnalysis, "file" | "signature" | "globals" | "structTypes" | "macroDefinitions" | "functions" | "unresolved">;

export async function buildFullIndex(options: BuildOptions): Promise<AnalysisIndex> {
  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  const parserEngine = options.parserEngine ?? "rust";
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto", options.projectConfiguration ?? "Release", options.sourceEncoding ?? "auto");
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
    rustSidecarTimeoutMs: options.rustSidecarTimeoutMs,
    sourceEncoding: options.sourceEncoding ?? "auto",
    includePaths: project.includePaths,
    macros: project.macros,
    diagnosticsDir: nativeDiagnosticsDir(options),
    maxRustAutoSkippedFiles: options.maxRustAutoSkippedFiles
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
    parserDiagnostics: scanResult.diagnostics,
    skippedFiles: scanResult.skippedFiles ?? [],
    analyzedFileCount: scanResult.files.length,
    fileSignatures: await skippedFileSignatures(scanResult.skippedFiles ?? [])
  });
}

export async function buildFullIndexToStorage(options: BuildOptions, indexPath: string): Promise<AnalysisIndex> {
  const parserEngine = options.parserEngine ?? "rust";
  if (parserEngine !== "rust") {
    const index = await buildFullIndex(options);
    await writeIndex(indexPath, index);
    return index;
  }

  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto", options.projectConfiguration ?? "Release", options.sourceEncoding ?? "auto");
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);
  return buildRustIndexToStorage({
    indexPath,
    options,
    mode: "full",
    started,
    phaseDurationsMs,
    project,
    threads: threadMap.threads,
    changedFiles: project.sourceFiles,
    reusedFiles: 0
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
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto", options.projectConfiguration ?? "Release", options.sourceEncoding ?? "auto");
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

  const previousFilesByPath = previousFileSignatures(previousIndex);
  phaseStarted = Date.now();
  const changedFiles = await findChangedFiles(project.sourceFiles, previousFilesByPath);
  phaseDurationsMs.signatureCheck = elapsedSince(phaseStarted);
  if (changedFiles.length === 0) {
    return {
      ...previousIndex,
      generatedAt: new Date().toISOString(),
      projectFile: project.projectFile,
      projectFiles: project.sourceFiles,
      includePaths: project.includePaths,
      macros: project.macros,
      threads: threadMap.threads,
      threadReachability: buildThreadReachability(threadMap.threads, previousIndex.callGraph),
      build: {
        mode: "update",
        parserMode: parserEngine,
        durationMs: Date.now() - started,
        phaseDurationsMs: {
          ...phaseDurationsMs,
          structureScan: 0,
          symbolMap: 0,
          accessAnalysis: 0
        },
        workerCount: 0,
        changedFiles,
        reusedFiles: project.sourceFiles.length,
        sourceFileCount: project.sourceFiles.length,
        analyzedFileCount: previousIndex.build.analyzedFileCount,
        skippedFiles: previousIndex.build.skippedFiles
      }
    };
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

export async function updateIndexToStorage(
  options: BuildOptions,
  previousIndex: AnalysisIndex | undefined,
  indexPath: string
): Promise<AnalysisIndex> {
  const parserEngine = options.parserEngine ?? "rust";
  if (parserEngine !== "rust") {
    const index = await updateIndex(options, previousIndex);
    await writeIndex(indexPath, index);
    return index;
  }
  if (!previousIndex) {
    const index = await buildFullIndexToStorage(options, indexPath);
    index.build.mode = "update";
    index.build.fullRebuildReason = "previous-index-missing";
    await writeIndex(indexPath, index);
    return index;
  }

  const started = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  let phaseStarted = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs, options.projectEncoding ?? "auto", options.projectConfiguration ?? "Release", options.sourceEncoding ?? "auto");
  phaseDurationsMs.projectParse = elapsedSince(phaseStarted);
  phaseStarted = Date.now();
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  phaseDurationsMs.threadMap = elapsedSince(phaseStarted);

  if (!sameStringSet(project.sourceFiles, previousIndex.projectFiles)) {
    return buildRustIndexToStorage({
      indexPath,
      options,
      mode: "update",
      started,
      phaseDurationsMs,
      project,
      threads: threadMap.threads,
      changedFiles: project.sourceFiles,
      reusedFiles: 0,
      fullRebuildReason: "project-source-list-changed"
    });
  }

  if (previousIndex.build.parserMode !== parserEngine) {
    return buildRustIndexToStorage({
      indexPath,
      options,
      mode: "update",
      started,
      phaseDurationsMs,
      project,
      threads: threadMap.threads,
      changedFiles: project.sourceFiles,
      reusedFiles: 0,
      fullRebuildReason: "parser-engine-changed"
    });
  }

  const previousFilesByPath = previousFileSignatures(previousIndex);
  phaseStarted = Date.now();
  const changedFiles = await findChangedFiles(project.sourceFiles, previousFilesByPath);
  phaseDurationsMs.signatureCheck = elapsedSince(phaseStarted);
  if (changedFiles.length === 0) {
    if (!(await splitFunctionSidecarExists(indexPath, previousIndex))) {
      return buildRustIndexToStorage({
        indexPath,
        options,
        mode: "update",
        started,
        phaseDurationsMs,
        project,
        threads: threadMap.threads,
        changedFiles: project.sourceFiles,
        reusedFiles: 0,
        fullRebuildReason: "function-sidecar-missing"
      });
    }
    const index: AnalysisIndex = {
      ...previousIndex,
      generatedAt: new Date().toISOString(),
      projectFile: project.projectFile,
      projectFiles: project.sourceFiles,
      includePaths: project.includePaths,
      macros: project.macros,
      threads: threadMap.threads,
      threadReachability: buildThreadReachability(threadMap.threads, previousIndex.callGraph),
      build: {
        mode: "update",
        parserMode: parserEngine,
        durationMs: Date.now() - started,
        phaseDurationsMs: {
          ...phaseDurationsMs,
          structureScan: 0,
          symbolMap: 0,
          accessAnalysis: 0
        },
        workerCount: 0,
        changedFiles,
        reusedFiles: project.sourceFiles.length,
        sourceFileCount: project.sourceFiles.length,
        analyzedFileCount: previousIndex.build.analyzedFileCount,
        skippedFiles: previousIndex.build.skippedFiles
      }
    };
    await writeIndex(indexPath, index);
    return index;
  }

  return buildRustIndexToStorage({
    indexPath,
    options,
    mode: "update",
    started,
    phaseDurationsMs,
    project,
    threads: threadMap.threads,
    changedFiles,
    reusedFiles: 0,
    fullRebuildReason: "rust-native-update-rebuild"
  });
}

async function buildRustIndexToStorage(args: {
  indexPath: string;
  options: BuildOptions;
  mode: "full" | "update";
  started: number;
  phaseDurationsMs: Record<string, number>;
  project: {
    workspaceRoot: string;
    projectFile: string;
    sourceFiles: string[];
    includePaths: string[];
    macros: string[];
  };
  threads: ThreadDefinition[];
  changedFiles: string[];
  reusedFiles: number;
  fullRebuildReason?: string;
}): Promise<AnalysisIndex> {
  let phaseStarted = Date.now();
  const output = await runRustAnalyzeManyToOutputWithAutoSkip({
    files: args.project.sourceFiles,
    maxIndexWorkers: args.options.maxIndexWorkers,
    sourceEncoding: args.options.sourceEncoding ?? "auto",
    maxNativeBatchFiles: args.options.maxNativeBatchFiles,
    timeoutMs: args.options.rustSidecarTimeoutMs,
    diagnosticsDir: nativeDiagnosticsDir(args.options, args.indexPath),
    maxSkippedFiles: args.options.maxRustAutoSkippedFiles,
    macros: args.project.macros,
    includePaths: args.project.includePaths
  });
  args.phaseDurationsMs.structureScan = elapsedSince(phaseStarted);
  const functionWriter = await createIndexFunctionWriter(args.indexPath);
  try {
    const composeStarted = Date.now();
    const summaryFiles: SummaryFile[] = [];
    const globals: Record<string, GlobalVariable[]> = {};
    const fileSignatures: Record<string, FileSignature> = {};
    Object.assign(fileSignatures, await skippedFileSignatures(output.skippedFiles ?? []));
    const fileUnresolved: FileAnalysis["unresolved"] = [];
    const callGraph: Record<string, string[]> = {};
    const calledBy: Record<string, string[]> = {};
    const accessIndex = new Map<string, Set<string>>();

    const parsed = await parseRustOutputFile(output.outputPath, async (file) => {
      fileSignatures[file.file] = file.signature;
      if (file.unresolved.length > 0) {
        fileUnresolved.push(...file.unresolved);
      }
      summaryFiles.push({
        file: file.file,
        signature: file.signature,
        globals: file.globals,
        structTypes: file.structTypes,
        macroDefinitions: file.macroDefinitions,
        functions: [],
        unresolved: file.unresolved
      });
      for (const global of file.globals) {
        globals[global.name] = [...(globals[global.name] ?? []), global];
      }
      for (const func of file.functions) {
        callGraph[func.name] = func.calls;
        for (const called of func.calls) {
          calledBy[called] = [...(calledBy[called] ?? []), func.name];
        }
        addAccessIndexEntries(accessIndex, func);
        await functionWriter.write(func);
      }
    });
    await functionWriter.commit();
    output.diagnostics.push(...(parsed.diagnostics ?? []));
    Object.assign(
      args.phaseDurationsMs,
      rustPhaseDurations(parsed.metrics, output.analyzedFileCount ?? summaryFiles.length, output.outputBytes, output.nativeBatchSize)
    );
    args.phaseDurationsMs.rustSkippedFileCount = output.skippedFiles?.length ?? 0;
    args.phaseDurationsMs.rustAnalyzedFileCount = output.analyzedFileCount ?? summaryFiles.length;
    args.phaseDurationsMs.symbolMap = args.phaseDurationsMs.rustSymbolMap ?? 0;
    args.phaseDurationsMs.accessAnalysis = args.phaseDurationsMs.rustAccessAnalysis ?? 0;

    const memberContext = buildMemberAnalysisContext(summaryFiles);
    const globalNames = new Set(Object.keys(globals));
    const macroContext = buildMacroAnalysisContext(summaryFiles, globalNames, memberContext);
    const structTypes: Record<string, StructTypeInfo> = {};
    const memberSymbols: Record<string, MemberSymbol[]> = {};
    const macroDefinitions: Record<string, MacroDefinition[]> = {};
    const macroAliases: Record<string, MacroAlias[]> = {};
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

    const normalizedCallGraph = normalizeStringArrayRecord(callGraph);
    const normalizedCalledBy = normalizeStringArrayRecord(calledBy);
    args.phaseDurationsMs.compose = elapsedSince(composeStarted);
    const index: AnalysisIndex = {
      version: 1,
      generatedAt: new Date().toISOString(),
      workspaceRoot: args.project.workspaceRoot,
      projectFile: args.project.projectFile,
      projectFiles: args.project.sourceFiles,
      includePaths: args.project.includePaths,
      macros: args.project.macros,
      files: [],
      fileSignatures,
      fileUnresolved,
      globals,
      structTypes,
      memberSymbols,
      macroDefinitions,
      macroAliases,
      parserDiagnostics: output.diagnostics,
      functions: {},
      accessIndex: objectFromSetMap(accessIndex),
      callGraph: normalizedCallGraph,
      calledBy: normalizedCalledBy,
      threads: args.threads,
      threadReachability: buildThreadReachability(args.threads, normalizedCallGraph),
      build: {
        mode: args.mode,
        parserMode: "rust",
        durationMs: Date.now() - args.started,
        phaseDurationsMs: args.phaseDurationsMs,
        workerCount: parsed.workerCount ?? 1,
        changedFiles: args.changedFiles,
        reusedFiles: args.reusedFiles,
        fullRebuildReason: args.fullRebuildReason,
        sourceFileCount: args.project.sourceFiles.length,
        analyzedFileCount: output.analyzedFileCount ?? summaryFiles.length,
        skippedFiles: output.skippedFiles?.length ? output.skippedFiles : undefined
      },
      storage: {
        layout: "split-v1",
        functionsPath: path.basename(functionWriter.targetPath)
      }
    };
    await writeIndex(args.indexPath, index);
    return index;
  } catch (error) {
    await functionWriter.dispose();
    throw error;
  } finally {
    await output.cleanup();
  }
}

function addAccessIndexEntries(index: Map<string, Set<string>>, func: FunctionInfo): void {
  for (const access of func.accesses) {
    addAccessIndexEntry(index, access.variableName, func.name);
    if (access.targetName) {
      addAccessIndexEntry(index, access.targetName, func.name);
    }
    if (access.accessExpression) {
      addAccessIndexEntry(index, normalizeAccessIndexSymbol(access.accessExpression), func.name);
    }
    for (const macroName of access.macroNames ?? []) {
      addAccessIndexEntry(index, macroName, func.name);
    }
  }
}

function addAccessIndexEntry(index: Map<string, Set<string>>, symbolName: string, functionName: string): void {
  if (!symbolName) {
    return;
  }
  (index.get(symbolName) ?? index.set(symbolName, new Set()).get(symbolName)!).add(functionName);
}

function normalizeAccessIndexSymbol(symbolName: string): string {
  return symbolName.replace(/\s+/g, "").replace(/\[[^\]]+\]/g, "[]");
}

function objectFromSetMap(values: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, items]) => [name, [...items].sort()])
  );
}

function normalizeStringArrayRecord(values: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, items]) => [key, [...new Set(items)].sort()])
  );
}

async function splitFunctionSidecarExists(indexPath: string, index: AnalysisIndex): Promise<boolean> {
  if (index.storage?.layout !== "split-v1") {
    return true;
  }
  const configured = index.storage.functionsPath;
  const functionsPath = path.isAbsolute(configured) ? configured : path.join(path.dirname(indexPath), configured);
  try {
    await fs.access(functionsPath);
    return true;
  } catch {
    return false;
  }
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
  skippedFiles?: SkippedSourceFile[];
  analyzedFileCount?: number;
  fileSignatures?: Record<string, FileSignature>;
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
  const fileSignatures = { ...(args.fileSignatures ?? {}) };

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
    fileSignatures[file.file] = file.signature;
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

  const normalizedCallGraph = normalizeStringArrayRecord(callGraph);
  const normalizedCalledBy = normalizeStringArrayRecord(calledBy);
  const index: AnalysisIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot: args.workspaceRoot,
    projectFile: args.projectFile,
    projectFiles: args.projectFiles,
    includePaths: args.includePaths,
    macros: args.macros,
    files: args.files,
    fileSignatures,
    globals,
    structTypes,
    memberSymbols,
    macroDefinitions,
    macroAliases,
    parserDiagnostics: args.parserDiagnostics,
    functions,
    callGraph: normalizedCallGraph,
    calledBy: normalizedCalledBy,
    threads: args.threads,
    threadReachability: buildThreadReachability(args.threads, normalizedCallGraph),
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
      sourceFileCount: args.sourceFileCount,
      analyzedFileCount: args.analyzedFileCount ?? args.files.length,
      skippedFiles: args.skippedFiles?.length ? args.skippedFiles : undefined
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
  previousFilesByPath: Map<string, FileSignature>
): Promise<string[]> {
  const checks = await mapWithConcurrency(
    projectFiles,
    SIGNATURE_CHECK_CONCURRENCY,
    async (file) => {
      const previous = previousFilesByPath.get(file);
      if (!previous) {
        return file;
      }
      const current = await getFileSignature(file);
      if (!sameFileSignature(current, previous)) {
        return file;
      }
      return undefined;
    }
  );
  return checks.filter((file): file is string => Boolean(file)).sort();
}

function previousFileSignatures(previousIndex: AnalysisIndex): Map<string, FileSignature> {
  if (previousIndex.fileSignatures) {
    return new Map(Object.entries(previousIndex.fileSignatures));
  }
  return new Map(previousIndex.files.map((file) => [file.file, file.signature]));
}

function sameFileSignature(left: FileSignature, right: FileSignature): boolean {
  return left.size === right.size && Math.abs(left.mtimeMs - right.mtimeMs) < 2;
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
  await mapWithConcurrency(
    projectFiles,
    SIGNATURE_CHECK_CONCURRENCY,
    async (file) => {
      signatures[file] = await getFileSignature(file);
    }
  );
  return signatures;
}

export async function verifySignaturesUnchanged(
  before: Record<string, FileSignature>
): Promise<{ ok: boolean; changed: string[] }> {
  const changed: string[] = [];
  await mapWithConcurrency(
    Object.entries(before),
    SIGNATURE_CHECK_CONCURRENCY,
    async ([file, signature]) => {
      const current = await getFileSignature(file);
      if (current.size !== signature.size || current.mtimeMs !== signature.mtimeMs) {
        changed.push(file);
      }
    }
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

function nativeDiagnosticsDir(options: BuildOptions, indexPath?: string): string | undefined {
  const outputDir = options.outputDir ?? (indexPath ? path.dirname(indexPath) : undefined);
  return outputDir ? path.join(outputDir, "native-diagnostics") : undefined;
}

async function skippedFileSignatures(skippedFiles: SkippedSourceFile[]): Promise<Record<string, FileSignature>> {
  const signatures: Record<string, FileSignature> = {};
  await mapWithConcurrency(skippedFiles, SIGNATURE_CHECK_CONCURRENCY, async (skipped) => {
    try {
      signatures[skipped.file] = await getFileSignature(skipped.file);
    } catch {
      // The skip diagnostic is still useful if the file disappeared before index composition.
    }
  });
  return signatures;
}

function elapsedSince(started: number): number {
  return Date.now() - started;
}
