import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AnalysisIndex, FileAnalysis, FunctionInfo } from "./types";
import { normalizePath, sanitizeFileName } from "./pathUtils";

const ARTIFACT_RELATIVE_ROOT = ".vscode/vc6-impact-review";
const INDEX_SUMMARY_TAIL_BYTES = 32 * 1024 * 1024;

export interface IndexBuildSummary {
  durationMs: number;
  workerCount: number;
  sourceFileCount: number;
  reusedFiles: number;
  skippedFileCount?: number;
}

export interface IndexFunctionWriter {
  targetPath: string;
  write(func: FunctionInfo): Promise<void>;
  commit(): Promise<void>;
  dispose(): Promise<void>;
}

export function resolveArtifactRoot(workspaceRoot: string): string {
  return normalizePath(path.join(workspaceRoot, ".vscode", "vc6-impact-review"));
}

export function resolveIndexPath(outputDir: string, indexDbPath?: string): string {
  if (indexDbPath?.trim()) {
    return normalizePath(indexDbPath);
  }
  return normalizePath(path.join(outputDir, "vc6-impact-index.json"));
}

export async function ensureArtifactIgnored(workspaceRoot: string, artifactRoot: string): Promise<void> {
  const normalizedWorkspace = normalizePath(workspaceRoot);
  const normalizedArtifact = normalizePath(artifactRoot);
  const relative = path.relative(normalizedWorkspace, normalizedArtifact).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  const gitRoot = await findGitRoot(normalizedWorkspace);
  if (!gitRoot) {
    return;
  }
  const artifactRelativeToGit = path.relative(gitRoot, normalizedArtifact).replace(/\\/g, "/");
  if (!artifactRelativeToGit || artifactRelativeToGit.startsWith("..") || path.isAbsolute(artifactRelativeToGit)) {
    return;
  }
  const excludePath = path.join(gitRoot, ".git", "info", "exclude");
  const ignoreLine = `${artifactRelativeToGit.replace(/\/?$/, "/")}`;
  let current = "";
  try {
    current = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const existing = current.split(/\r?\n/).map((line) => line.trim());
  if (existing.includes(ignoreLine)) {
    return;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(excludePath, `${current}${prefix}${ignoreLine}\n`, "utf8");
}

async function findGitRoot(startDir: string): Promise<string | undefined> {
  let current = normalizePath(startDir);
  while (true) {
    try {
      await fs.access(path.join(current, ".git", "info"));
      return current;
    } catch {
      // move upward
    }
    const parent = normalizePath(path.dirname(current));
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function readIndex(indexPath: string): Promise<AnalysisIndex | undefined> {
  try {
    const text = await fs.readFile(indexPath, "utf8");
    return JSON.parse(text) as AnalysisIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readIndexBuildSummary(indexPath: string): Promise<IndexBuildSummary | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const stat = await fs.stat(indexPath);
    const length = Math.min(stat.size, INDEX_SUMMARY_TAIL_BYTES);
    handle = await fs.open(indexPath, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return parseIndexBuildSummaryTail(buffer.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseIndexBuildSummaryTail(tail: string): IndexBuildSummary | undefined {
  const buildStart = tail.lastIndexOf('"build"');
  if (buildStart < 0) {
    return undefined;
  }
  const buildText = tail.slice(buildStart);
  const durationMs = matchNumberProperty(buildText, "durationMs");
  const workerCount = matchNumberProperty(buildText, "workerCount");
  const sourceFileCount = matchNumberProperty(buildText, "sourceFileCount");
  const reusedFiles = matchNumberProperty(buildText, "reusedFiles");
  const skippedFileCount = countSkippedFiles(buildText);
  if (
    typeof durationMs !== "number" ||
    typeof workerCount !== "number" ||
    typeof sourceFileCount !== "number" ||
    typeof reusedFiles !== "number"
  ) {
    return undefined;
  }
  return {
    durationMs,
    workerCount,
    sourceFileCount,
    reusedFiles,
    ...(typeof skippedFileCount === "number" ? { skippedFileCount } : {})
  };
}

function matchNumberProperty(text: string, property: string): number | undefined {
  const match = new RegExp(`"${property}"\\s*:\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : undefined;
}

export async function writeIndex(indexPath: string, index: AnalysisIndex): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const stored = splitIndexForStorage(indexPath, index);
  const functionsPath = resolveStoredFunctionsPath(indexPath, stored);
  if (Object.keys(index.functions).length > 0) {
    await writeFunctionsJsonl(functionsPath, Object.values(index.functions));
  } else if (index.storage?.layout === "split-v1") {
    await fs.access(functionsPath).catch(async () => writeFunctionsJsonl(functionsPath, []));
  } else {
    await writeFunctionsJsonl(functionsPath, []);
  }
  await writeCompactJsonFile(indexPath, stored);
}

function countSkippedFiles(text: string): number | undefined {
  const propertyIndex = text.indexOf('"skippedFiles"');
  if (propertyIndex < 0) {
    return undefined;
  }
  const arrayStart = text.indexOf("[", propertyIndex);
  if (arrayStart < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objects = 0;
  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return objects;
      }
      continue;
    }
    if (char === "{" && depth === 1) {
      objects += 1;
    }
  }
  return undefined;
}

export async function createIndexFunctionWriter(indexPath: string): Promise<IndexFunctionWriter> {
  const targetPath = functionsSidecarPath(indexPath);
  const tempPath = tempWritePath(targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const stream = nodeFs.createWriteStream(tempPath, { encoding: "utf8" });
  let closed = false;
  return {
    targetPath,
    async write(func: FunctionInfo): Promise<void> {
      if (closed) {
        throw new Error("function sidecar writer is already closed");
      }
      await writeJsonValue(stream, func);
      await writeChunk(stream, "\n");
    },
    async commit(): Promise<void> {
      if (!closed) {
        closed = true;
        await endStream(stream);
      }
      await fs.rename(tempPath, targetPath);
    },
    async dispose(): Promise<void> {
      if (!closed) {
        closed = true;
        stream.destroy();
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  };
}

export function reportPaths(outputDir: string, symbolName: string): { markdown: string; html: string } {
  const base = sanitizeFileName(symbolName);
  const reportDir = path.join(outputDir, "reports");
  return {
    markdown: normalizePath(path.join(reportDir, `${base}.md`)),
    html: normalizePath(path.join(reportDir, `${base}.html`))
  };
}

export function reportRelativeLink(markdownPath: string, targetPath: string, line?: number): string {
  const markdownDir = path.dirname(markdownPath);
  const relative = path.relative(markdownDir, targetPath).replace(/\\/g, "/");
  const normalized = relative && !path.isAbsolute(relative) ? relative : targetPath.replace(/\\/g, "/");
  return line ? `${normalized}#L${line}` : normalized;
}

export function reportDisplayPath(workspaceRoot: string, targetPath: string): string {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : targetPath.replace(/\\/g, "/");
}

export function reportArtifactDisplayPath(outputDir: string, targetPath: string): string {
  const relative = path.relative(outputDir, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : targetPath.replace(/\\/g, "/");
}

export { ARTIFACT_RELATIVE_ROOT };

function splitIndexForStorage(indexPath: string, index: AnalysisIndex): AnalysisIndex {
  return {
    ...index,
    files: [],
    functions: {},
    fileSignatures: index.fileSignatures ?? Object.fromEntries(index.files.map((file) => [file.file, file.signature])),
    fileUnresolved: index.fileUnresolved ?? index.files.flatMap((file) => file.unresolved ?? []),
    accessIndex: index.accessIndex ?? buildAccessIndex(index.functions),
    storage: {
      layout: "split-v1",
      functionsPath: path.basename(functionsSidecarPath(indexPath))
    }
  };
}

function functionsSidecarPath(indexPath: string): string {
  const parsed = path.parse(indexPath);
  return normalizePath(path.join(parsed.dir, `${parsed.name}.functions.jsonl`));
}

function resolveStoredFunctionsPath(indexPath: string, index: AnalysisIndex): string {
  const configured = index.storage?.functionsPath;
  if (!configured) {
    return functionsSidecarPath(indexPath);
  }
  return normalizePath(path.isAbsolute(configured) ? configured : path.join(path.dirname(indexPath), configured));
}

function buildAccessIndex(functions: Record<string, FunctionInfo>): Record<string, string[]> {
  const bySymbol = new Map<string, Set<string>>();
  for (const func of Object.values(functions)) {
    for (const access of func.accesses) {
      addAccessIndexEntry(bySymbol, access.variableName, func.name);
      if (access.targetName) {
        addAccessIndexEntry(bySymbol, access.targetName, func.name);
      }
      for (const macroName of access.macroNames ?? []) {
        addAccessIndexEntry(bySymbol, macroName, func.name);
      }
    }
  }
  return Object.fromEntries(
    [...bySymbol.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([symbol, names]) => [symbol, [...names].sort()])
  );
}

function addAccessIndexEntry(index: Map<string, Set<string>>, symbolName: string, functionName: string): void {
  if (!symbolName) {
    return;
  }
  (index.get(symbolName) ?? index.set(symbolName, new Set()).get(symbolName)!).add(functionName);
}

function functionNamesForSymbol(index: AnalysisIndex, symbolName: string, maxDepth: number): Set<string> {
  const names = new Set<string>();
  const macros = index.macroAliases?.[symbolName] ?? [];
  const isFunction = Boolean(index.callGraph[symbolName] || index.calledBy[symbolName]);
  if (isFunction) {
    return collectFunctionNeighborhoodNames(index, symbolName, maxDepth);
  }
  for (const name of index.accessIndex?.[symbolName] ?? []) {
    names.add(name);
  }
  for (const macro of macros) {
    for (const name of index.accessIndex?.[macro.name] ?? []) {
      names.add(name);
    }
    for (const name of index.accessIndex?.[macro.targetName] ?? []) {
      names.add(name);
    }
  }
  return names;
}

function collectFunctionNeighborhoodNames(index: AnalysisIndex, functionName: string, maxDepth: number): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ name: string; depth: number }> = [{ name: functionName, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.name) || current.depth > maxDepth) {
      continue;
    }
    visited.add(current.name);
    for (const next of [...(index.callGraph[current.name] ?? []), ...(index.calledBy[current.name] ?? [])]) {
      queue.push({ name: next, depth: current.depth + 1 });
    }
  }
  return visited;
}

async function readFunctionsByName(functionsPath: string, names: Set<string>): Promise<Record<string, FunctionInfo>> {
  const functions: Record<string, FunctionInfo> = {};
  if (names.size === 0) {
    return functions;
  }
  try {
    await fs.access(functionsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`function sidecar is missing; rebuild the VC6 Impact index: ${functionsPath}`);
    }
    throw error;
  }
  let buffer = "";
  for await (const chunk of nodeFs.createReadStream(functionsPath, { encoding: "utf8" })) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      readFunctionLine(line, names, functions);
      if (Object.keys(functions).length === names.size) {
        return functions;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  readFunctionLine(buffer.trim(), names, functions);
  return functions;
}

function readFunctionLine(line: string, names: Set<string>, functions: Record<string, FunctionInfo>): void {
  if (!line) {
    return;
  }
  const func = JSON.parse(line) as FunctionInfo;
  if (names.has(func.name)) {
    functions[func.name] = func;
  }
}

function unresolvedFilesFromStoredIndex(index: AnalysisIndex): FileAnalysis[] {
  const byFile = new Map<string, FileAnalysis>();
  for (const item of index.fileUnresolved ?? []) {
    const existing = byFile.get(item.location.file);
    if (existing) {
      existing.unresolved.push(item);
      continue;
    }
    byFile.set(item.location.file, {
      file: item.location.file,
      signature: index.fileSignatures?.[item.location.file] ?? { size: 0, mtimeMs: 0 },
      globals: [],
      structTypes: [],
      macroDefinitions: [],
      functions: [],
      unresolved: [item]
    });
  }
  return [...byFile.values()];
}

async function writeFunctionsJsonl(file: string, functions: FunctionInfo[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempPath = tempWritePath(file);
  const stream = nodeFs.createWriteStream(tempPath, { encoding: "utf8" });
  try {
    for (const func of functions.sort((left, right) => left.name.localeCompare(right.name))) {
      await writeJsonValue(stream, func);
      await writeChunk(stream, "\n");
    }
    await endStream(stream);
    await fs.rename(tempPath, file);
  } catch (error) {
    stream.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeCompactJsonFile(file: string, value: unknown): Promise<void> {
  const tempPath = tempWritePath(file);
  const stream = nodeFs.createWriteStream(tempPath, { encoding: "utf8" });
  try {
    await writeJsonValue(stream, value);
    await writeChunk(stream, "\n");
    await endStream(stream);
    await fs.rename(tempPath, file);
  } catch (error) {
    stream.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function tempWritePath(file: string): string {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function readIndexForSymbol(indexPath: string, symbolName: string, maxDepth = 4): Promise<AnalysisIndex | undefined> {
  const index = await readIndex(indexPath);
  if (!index || index.storage?.layout !== "split-v1") {
    return index;
  }
  const functionNames = functionNamesForSymbol(index, symbolName, maxDepth);
  return {
    ...index,
    functions: await readFunctionsByName(resolveStoredFunctionsPath(indexPath, index), functionNames),
    files: unresolvedFilesFromStoredIndex(index)
  };
}

async function writeJsonValue(stream: nodeFs.WriteStream, value: unknown): Promise<void> {
  if (value === undefined) {
    await writeChunk(stream, "null");
    return;
  }
  if (value === null || typeof value !== "object") {
    await writeChunk(stream, JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    await writeChunk(stream, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        await writeChunk(stream, ",");
      }
      await writeJsonValue(stream, value[index]);
    }
    await writeChunk(stream, "]");
    return;
  }
  await writeChunk(stream, "{");
  let first = true;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) {
      continue;
    }
    if (!first) {
      await writeChunk(stream, ",");
    }
    await writeChunk(stream, JSON.stringify(key));
    await writeChunk(stream, ":");
    await writeJsonValue(stream, child);
    first = false;
  }
  await writeChunk(stream, "}");
}

async function writeChunk(stream: nodeFs.WriteStream, chunk: string): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function endStream(stream: nodeFs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onFinish = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      stream.off("error", onError);
    };
    stream.once("error", onError);
    stream.end(onFinish);
  });
}
