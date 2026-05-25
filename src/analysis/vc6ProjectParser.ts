import * as fs from "node:fs/promises";
import * as path from "node:path";
import { matchesExcluded, normalizePath, resolveMaybeRelative } from "./pathUtils";
import { readTextFile, type TextEncoding } from "./textEncoding";
import type { Vc6ProjectInfo } from "./types";

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".inl"]);

export async function parseVc6Project(
  workspaceRoot: string,
  projectFile: string,
  excludeGlobs: string[] = [],
  projectEncoding: TextEncoding = "auto"
): Promise<Vc6ProjectInfo> {
  const resolvedProjectFile = resolveMaybeRelative(workspaceRoot, projectFile);
  const ext = path.extname(resolvedProjectFile).toLowerCase();
  const dspFiles =
    ext === ".dsw" ? await parseDswForDspFiles(resolvedProjectFile, projectEncoding) : [resolvedProjectFile];

  const sourceFiles = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();

  for (const dspFile of dspFiles) {
    const dsp = await parseDsp(dspFile, workspaceRoot, excludeGlobs, projectEncoding);
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

async function parseDswForDspFiles(dswFile: string, projectEncoding: TextEncoding): Promise<string[]> {
  const text = (await readTextFile(dswFile, projectEncoding)).text;
  const baseDir = path.dirname(dswFile);
  const dspFiles: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const dspPath = parseDswProjectPath(rawLine);
    if (dspPath) {
      dspFiles.push(resolveMaybeRelative(baseDir, dspPath));
    }
  }
  return dspFiles.length > 0 ? dspFiles : [dswFile.replace(/\.dsw$/i, ".dsp")];
}

async function parseDsp(
  dspFile: string,
  workspaceRoot: string,
  excludeGlobs: string[],
  projectEncoding: TextEncoding
): Promise<Pick<Vc6ProjectInfo, "sourceFiles" | "includePaths" | "macros">> {
  const text = (await readTextFile(dspFile, projectEncoding)).text;
  const baseDir = path.dirname(dspFile);
  const sourceFiles = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sourceMatch = /^SOURCE=(.+)$/i.exec(line);
    if (sourceMatch) {
      const sourcePath = parseVc6PathValue(sourceMatch[1]);
      if (!sourcePath) {
        continue;
      }
      const sourceFile = resolveMaybeRelative(baseDir, sourcePath);
      if (SOURCE_EXTENSIONS.has(path.extname(sourceFile).toLowerCase()) && !matchesExcluded(sourceFile, excludeGlobs)) {
        sourceFiles.add(sourceFile);
      }
      continue;
    }

    const tokens = tokenizeVc6CommandLine(line);
    for (const includePath of extractSwitchValues(tokens, "I")) {
      includePaths.add(resolveMaybeRelative(workspaceRoot, includePath));
    }

    for (const macro of extractSwitchValues(tokens, "D")) {
      macros.add(macro);
    }
  }

  return {
    sourceFiles: [...sourceFiles].sort(),
    includePaths: [...includePaths].sort(),
    macros: [...macros].sort()
  };
}

function parseDswProjectPath(line: string): string | undefined {
  if (!/^Project:/i.test(line.trimStart())) {
    return undefined;
  }
  const equalsIndex = line.indexOf("=");
  if (equalsIndex < 0) {
    return undefined;
  }
  const value = line.slice(equalsIndex + 1);
  const pathValue = parseVc6PathValue(value, true);
  return pathValue && path.extname(pathValue).toLowerCase() === ".dsp" ? pathValue : undefined;
}

function parseVc6PathValue(value: string, stopAtProjectSuffix = false): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    const quoted = closing >= 0 ? trimmed.slice(1, closing) : trimmed.slice(1);
    return quoted.trim() || undefined;
  }
  const suffixMatch = stopAtProjectSuffix ? /\s+-\s+/.exec(trimmed) : undefined;
  const unquoted = suffixMatch ? trimmed.slice(0, suffixMatch.index) : trimmed;
  return unquoted.trim() || undefined;
}

function tokenizeVc6CommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function extractSwitchValues(tokens: string[], switchName: "I" | "D"): string[] {
  const values: string[] = [];
  const slashSwitch = `/${switchName}`.toUpperCase();
  const dashSwitch = `-${switchName}`.toUpperCase();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const upper = token.toUpperCase();
    if (upper === slashSwitch || upper === dashSwitch) {
      const value = tokens[index + 1];
      if (value) {
        values.push(value);
        index += 1;
      }
      continue;
    }
    if (upper.startsWith(slashSwitch) || upper.startsWith(dashSwitch)) {
      const value = token.slice(2);
      if (value) {
        values.push(value);
      }
    }
  }
  return values;
}
