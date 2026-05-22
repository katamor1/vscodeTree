import * as fs from "node:fs/promises";
import { parseVc6Project } from "./vc6ProjectParser";
import { readThreadMap } from "./threadMap";
import { analyzeFileStructure, getFileSignature, scanFileStructure } from "./sourceScanner";
import type {
  AnalysisIndex,
  BuildOptions,
  FileAnalysis,
  FileSignature,
  FunctionInfo,
  GlobalVariable,
  ThreadDefinition,
  ThreadReachability
} from "./types";

export async function buildFullIndex(options: BuildOptions): Promise<AnalysisIndex> {
  const started = Date.now();
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs);
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  const structures = await Promise.all(project.sourceFiles.map((file) => scanFileStructure(file)));
  const globalNames = new Set(structures.flatMap((file) => file.globals.map((global) => global.name)));
  const functionNames = new Set(structures.flatMap((file) => file.functions.map((func) => func.name)));
  const files = structures.map((structure) => analyzeFileStructure(structure, globalNames, functionNames));

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
    changedFiles: project.sourceFiles,
    reusedFiles: 0,
    sourceFileCount: project.sourceFiles.length
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
  const project = await parseVc6Project(options.workspaceRoot, options.projectFile, options.excludeGlobs);
  const threadMap = await readThreadMap(options.workspaceRoot, options.threadMapFile);
  const projectFilesChanged = !sameStringSet(project.sourceFiles, previousIndex.projectFiles);
  if (projectFilesChanged) {
    const index = await buildFullIndex(options);
    index.build.mode = "update";
    index.build.fullRebuildReason = "project-source-list-changed";
    return index;
  }

  const previousFilesByPath = new Map(previousIndex.files.map((file) => [file.file, file]));
  const changedFiles = await findChangedFiles(project.sourceFiles, previousFilesByPath);
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
      sourceFileCount: project.sourceFiles.length
    });
  }

  const changedStructures = await Promise.all(changedFiles.map((file) => scanFileStructure(file)));
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

  const previousGlobalNames = new Set(Object.keys(previousIndex.globals));
  const previousFunctionNames = new Set(Object.keys(previousIndex.functions));
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

  const globalNames = previousGlobalNames;
  const functionNames = previousFunctionNames;
  const changedAnalyses = changedStructures.map((structure) =>
    analyzeFileStructure(structure, globalNames, functionNames)
  );
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
    changedFiles,
    reusedFiles: files.length - changedFiles.length,
    sourceFileCount: project.sourceFiles.length
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
  changedFiles: string[];
  reusedFiles: number;
  sourceFileCount: number;
}): AnalysisIndex {
  const globals: Record<string, GlobalVariable[]> = {};
  const functions: Record<string, FunctionInfo> = {};
  const callGraph: Record<string, string[]> = {};
  const calledBy: Record<string, string[]> = {};

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

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot: args.workspaceRoot,
    projectFile: args.projectFile,
    projectFiles: args.projectFiles,
    includePaths: args.includePaths,
    macros: args.macros,
    files: args.files,
    globals,
    functions,
    callGraph,
    calledBy,
    threads: args.threads,
    threadReachability: buildThreadReachability(args.threads, callGraph),
    build: {
      mode: args.mode,
      durationMs: Date.now() - args.started,
      changedFiles: args.changedFiles,
      reusedFiles: args.reusedFiles,
      sourceFileCount: args.sourceFileCount
    }
  };
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
  const changed: string[] = [];
  for (const file of projectFiles) {
    const previous = previousFilesByPath.get(file);
    if (!previous) {
      changed.push(file);
      continue;
    }
    const current = await getFileSignature(file);
    if (current.size !== previous.signature.size || current.mtimeMs !== previous.signature.mtimeMs) {
      changed.push(file);
    }
  }
  return changed.sort();
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
