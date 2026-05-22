import * as fs from "node:fs/promises";
import * as path from "node:path";
import { matchesExcluded, normalizePath, resolveMaybeRelative } from "./pathUtils";
import type { Vc6ProjectInfo } from "./types";

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".inl"]);

export async function parseVc6Project(
  workspaceRoot: string,
  projectFile: string,
  excludeGlobs: string[] = []
): Promise<Vc6ProjectInfo> {
  const resolvedProjectFile = resolveMaybeRelative(workspaceRoot, projectFile);
  const ext = path.extname(resolvedProjectFile).toLowerCase();
  const dspFiles =
    ext === ".dsw" ? await parseDswForDspFiles(resolvedProjectFile) : [resolvedProjectFile];

  const sourceFiles = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();

  for (const dspFile of dspFiles) {
    const dsp = await parseDsp(dspFile, workspaceRoot, excludeGlobs);
    dsp.sourceFiles.forEach((file) => sourceFiles.add(file));
    dsp.includePaths.forEach((includePath) => includePaths.add(includePath));
    dsp.macros.forEach((macro) => macros.add(macro));
  }

  return {
    projectFile: resolvedProjectFile,
    workspaceRoot: normalizePath(workspaceRoot),
    sourceFiles: [...sourceFiles].sort(),
    includePaths: [...includePaths].sort(),
    macros: [...macros].sort()
  };
}

export async function findDefaultProjectFile(workspaceRoot: string): Promise<string | undefined> {
  const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  const dsw = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dsw"));
  if (dsw) {
    return normalizePath(path.join(workspaceRoot, dsw.name));
  }
  const dsp = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dsp"));
  return dsp ? normalizePath(path.join(workspaceRoot, dsp.name)) : undefined;
}

async function parseDswForDspFiles(dswFile: string): Promise<string[]> {
  const text = await fs.readFile(dswFile, "utf8");
  const baseDir = path.dirname(dswFile);
  const dspFiles: string[] = [];
  const projectRegex = /^Project:\s*"[^"]+"\s*=\s*"([^"]+\.dsp)"/gim;
  for (const match of text.matchAll(projectRegex)) {
    dspFiles.push(resolveMaybeRelative(baseDir, match[1]));
  }
  return dspFiles.length > 0 ? dspFiles : [dswFile.replace(/\.dsw$/i, ".dsp")];
}

async function parseDsp(
  dspFile: string,
  workspaceRoot: string,
  excludeGlobs: string[]
): Promise<Pick<Vc6ProjectInfo, "sourceFiles" | "includePaths" | "macros">> {
  const text = await fs.readFile(dspFile, "utf8");
  const baseDir = path.dirname(dspFile);
  const sourceFiles = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sourceMatch = /^SOURCE=(.+)$/i.exec(line);
    if (sourceMatch) {
      const sourceFile = resolveMaybeRelative(baseDir, sourceMatch[1]);
      if (SOURCE_EXTENSIONS.has(path.extname(sourceFile).toLowerCase()) && !matchesExcluded(sourceFile, excludeGlobs)) {
        sourceFiles.add(sourceFile);
      }
      continue;
    }

    const includeMatch = /\/I\s+"?([^"\s]+)"?/gi;
    for (const match of line.matchAll(includeMatch)) {
      includePaths.add(resolveMaybeRelative(workspaceRoot, match[1]));
    }

    const defineMatch = /\/D\s+"?([^"\s]+)"?/gi;
    for (const match of line.matchAll(defineMatch)) {
      macros.add(match[1]);
    }
  }

  return {
    sourceFiles: [...sourceFiles].sort(),
    includePaths: [...includePaths].sort(),
    macros: [...macros].sort()
  };
}
