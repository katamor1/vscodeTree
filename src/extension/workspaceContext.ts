import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath, resolveMaybeRelative } from "../analysis/pathUtils";
import { findDefaultProjectFile } from "../analysis/vc6ProjectParser";

export const VC6_PROJECT_CONTEXT_KEY = "vc6Impact.hasProject";

export interface Vc6ProjectContextOptions {
  workspaceRoot: string | undefined;
  projectFileSetting: string | undefined;
  setContext: (key: string, value: boolean) => unknown;
}

export async function updateVc6ProjectContext(options: Vc6ProjectContextOptions): Promise<void> {
  const { workspaceRoot, projectFileSetting, setContext } = options;
  const hasProject = await hasVc6ProjectFolder(workspaceRoot, projectFileSetting);
  await setContext(VC6_PROJECT_CONTEXT_KEY, hasProject);
}

export async function hasVc6ProjectFolder(
  workspaceRoot: string | undefined,
  projectFileSetting: string | undefined
): Promise<boolean> {
  if (!workspaceRoot) {
    return false;
  }

  const normalizedRoot = normalizePath(workspaceRoot);
  const configuredProjectFile = projectFileSetting?.trim() ?? "";
  if (configuredProjectFile) {
    const projectFile = resolveMaybeRelative(normalizedRoot, configuredProjectFile);
    return isInsideWorkspace(normalizedRoot, projectFile) && isVc6ProjectFile(projectFile) && (await fileExists(projectFile));
  }

  try {
    return (await findDefaultProjectFile(normalizedRoot)) !== undefined;
  } catch {
    return false;
  }
}

function isVc6ProjectFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".dsw" || ext === ".dsp";
}

function isInsideWorkspace(workspaceRoot: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
