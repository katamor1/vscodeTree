import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AnalysisIndex } from "./types";
import { normalizePath, sanitizeFileName } from "./pathUtils";

export function resolveIndexPath(outputDir: string, indexDbPath?: string): string {
  if (indexDbPath?.trim()) {
    return normalizePath(indexDbPath);
  }
  return normalizePath(path.join(outputDir, "vc6-impact-index.json"));
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

export async function writeIndex(indexPath: string, index: AnalysisIndex): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export function reportPaths(outputDir: string, symbolName: string): { markdown: string; html: string } {
  const base = sanitizeFileName(symbolName);
  const reportDir = path.join(outputDir, "reports");
  return {
    markdown: normalizePath(path.join(reportDir, `${base}.md`)),
    html: normalizePath(path.join(reportDir, `${base}.html`))
  };
}
