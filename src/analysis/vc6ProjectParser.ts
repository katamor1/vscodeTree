import * as fs from "node:fs/promises";
import * as path from "node:path";
import { mapWithConcurrency } from "./limitedConcurrency";
import { matchesExcluded, normalizePath, resolveMaybeRelative } from "./pathUtils";
import { readTextFile, type TextEncoding } from "./textEncoding";
import type { Vc6ProjectInfo } from "./types";

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".inl"]);
const FILE_EXISTS_CONCURRENCY = 64;

export async function parseVc6Project(
  workspaceRoot: string,
  projectFile: string,
  excludeGlobs: string[] = [],
  projectEncoding: TextEncoding = "auto",
  projectConfiguration = "Release"
): Promise<Vc6ProjectInfo> {
  const resolvedProjectFile = resolveMaybeRelative(workspaceRoot, projectFile);
  const ext = path.extname(resolvedProjectFile).toLowerCase();
  const dspFiles =
    ext === ".dsw" ? await parseDswForDspFiles(resolvedProjectFile, projectEncoding) : [resolvedProjectFile];

  const sourceFiles = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();

  for (const dspFile of dspFiles) {
    if (ext === ".dsw" && !(await fileExists(dspFile))) {
      continue;
    }
    const dsp = await parseDsp(dspFile, workspaceRoot, excludeGlobs, projectEncoding, projectConfiguration);
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
  projectEncoding: TextEncoding,
  projectConfiguration: string
): Promise<Pick<Vc6ProjectInfo, "sourceFiles" | "includePaths" | "macros">> {
  const text = (await readTextFile(dspFile, projectEncoding)).text;
  const baseDir = path.dirname(dspFile);
  const sourceCandidates = new Set<string>();
  const includePaths = new Set<string>();
  const macros = new Set<string>();
  const lines = text.split(/\r?\n/);
  const selectedConfiguration = selectVc6Configuration(lines, projectConfiguration);
  let insideSourceBlock = false;
  let currentSourceFile: string | undefined;

  for (const rawLine of filterVc6ConfigurationLines(lines, selectedConfiguration)) {
    const line = rawLine.trim();
    if (/^#\s*Begin Source File/i.test(line)) {
      insideSourceBlock = true;
      currentSourceFile = undefined;
      continue;
    }
    if (/^#\s*End Source File/i.test(line)) {
      insideSourceBlock = false;
      currentSourceFile = undefined;
      continue;
    }

    const sourceMatch = /^SOURCE=(.+)$/i.exec(line);
    if (sourceMatch) {
      const sourcePath = parseVc6PathValue(sourceMatch[1]);
      if (!sourcePath) {
        continue;
      }
      const sourceFile = resolveMaybeRelative(baseDir, sourcePath);
      if (
        SOURCE_EXTENSIONS.has(path.extname(sourceFile).toLowerCase()) &&
        !matchesExcluded(sourceFile, excludeGlobs)
      ) {
        sourceCandidates.add(sourceFile);
        currentSourceFile = insideSourceBlock ? sourceFile : undefined;
      }
      continue;
    }

    if (currentSourceFile && /^#\s*PROP\s+Exclude_From_Build\s+1\b/i.test(line)) {
      sourceCandidates.delete(currentSourceFile);
      continue;
    }

    const tokens = tokenizeVc6CommandLine(line);
    if (!currentSourceFile) {
      for (const includePath of extractSwitchValues(tokens, "I")) {
        includePaths.add(resolveMaybeRelative(workspaceRoot, includePath));
      }

      for (const macro of extractSwitchValues(tokens, "D")) {
        macros.add(macro);
      }
    }
  }

  const sourceFiles = await filterExistingFiles([...sourceCandidates]);
  return {
    sourceFiles: sourceFiles.sort(),
    includePaths: [...includePaths].sort(),
    macros: [...macros].sort()
  };
}

function selectVc6Configuration(lines: string[], requestedConfiguration: string): string | undefined {
  const configurations = lines.flatMap((line) => {
    const match = line.match(/^#\s*Name\s+"([^"]+)"/i);
    return match ? [match[1]] : [];
  });
  if (configurations.length === 0) {
    return undefined;
  }
  const requested = requestedConfiguration.trim() || "Release";
  const exact = configurations.find((configuration) => sameText(configuration, requested));
  if (exact) {
    return exact;
  }
  const contained = configurations.find((configuration) => configuration.toLowerCase().includes(requested.toLowerCase()));
  if (contained) {
    return contained;
  }
  return configurations.find((configuration) => /\bRelease\b/i.test(configuration)) ?? configurations[0];
}

interface Vc6ConditionFrame {
  parentActive: boolean;
  branchActive: boolean;
  branchTaken: boolean;
}

function filterVc6ConfigurationLines(lines: string[], selectedConfiguration: string | undefined): string[] {
  if (!selectedConfiguration) {
    return lines;
  }
  const frames: Vc6ConditionFrame[] = [];
  const output: string[] = [];
  for (const line of lines) {
    const directive = parseVc6ConditionDirective(line);
    const currentActive = frames.every((frame) => frame.branchActive);
    if (!directive) {
      if (currentActive) {
        output.push(line);
      }
      continue;
    }

    if (directive.kind === "if") {
      const parentActive = currentActive;
      const condition = evaluateVc6ConfigurationCondition(directive.condition, selectedConfiguration);
      frames.push({
        parentActive,
        branchActive: parentActive && condition,
        branchTaken: parentActive && condition
      });
      continue;
    }

    if (directive.kind === "elseif") {
      const frame = frames.at(-1);
      if (!frame) {
        continue;
      }
      const condition = evaluateVc6ConfigurationCondition(directive.condition, selectedConfiguration);
      frame.branchActive = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken = frame.branchTaken || frame.branchActive;
      continue;
    }

    if (directive.kind === "else") {
      const frame = frames.at(-1);
      if (frame) {
        frame.branchActive = frame.parentActive && !frame.branchTaken;
        frame.branchTaken = true;
      }
      continue;
    }

    frames.pop();
  }
  return output;
}

function parseVc6ConditionDirective(line: string):
  | { kind: "if" | "elseif"; condition: string }
  | { kind: "else" | "endif"; condition?: undefined }
  | undefined {
  const trimmed = line.trim();
  const ifMatch = /^!IF\s+(.+)$/i.exec(trimmed);
  if (ifMatch) {
    return { kind: "if", condition: ifMatch[1] };
  }
  const elseifMatch = /^!ELSEIF\s+(.+)$/i.exec(trimmed);
  if (elseifMatch) {
    return { kind: "elseif", condition: elseifMatch[1] };
  }
  if (/^!ELSE$/i.test(trimmed)) {
    return { kind: "else" };
  }
  if (/^!ENDIF$/i.test(trimmed)) {
    return { kind: "endif" };
  }
  return undefined;
}

function evaluateVc6ConfigurationCondition(condition: string, selectedConfiguration: string): boolean {
  const match = condition.match(/"?\$\(\s*CFG\s*\)"?\s*(==|!=)\s*"([^"]+)"/i);
  if (!match) {
    return true;
  }
  const equals = sameText(match[2], selectedConfiguration);
  return match[1] === "==" ? equals : !equals;
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function filterExistingFiles(files: string[]): Promise<string[]> {
  const checked = await mapWithConcurrency(files, FILE_EXISTS_CONCURRENCY, async (file) =>
    (await fileExists(file)) ? file : undefined
  );
  return checked.filter((file): file is string => typeof file === "string");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
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
