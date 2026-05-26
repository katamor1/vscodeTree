import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AnalysisIndex } from "./types";
import { normalizePath, sanitizeFileName } from "./pathUtils";

const ARTIFACT_RELATIVE_ROOT = ".vscode/vc6-impact-review";
const INDEX_SUMMARY_TAIL_BYTES = 32 * 1024 * 1024;

export interface IndexBuildSummary {
  durationMs: number;
  workerCount: number;
  sourceFileCount: number;
  reusedFiles: number;
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
  if (
    typeof durationMs !== "number" ||
    typeof workerCount !== "number" ||
    typeof sourceFileCount !== "number" ||
    typeof reusedFiles !== "number"
  ) {
    return undefined;
  }
  return { durationMs, workerCount, sourceFileCount, reusedFiles };
}

function matchNumberProperty(text: string, property: string): number | undefined {
  const match = new RegExp(`"${property}"\\s*:\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : undefined;
}

export async function writeIndex(indexPath: string, index: AnalysisIndex): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
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
