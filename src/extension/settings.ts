import * as path from "node:path";
import * as vscode from "vscode";
import { findDefaultProjectFile } from "../analysis/vc6ProjectParser";
import { normalizePath, resolveMaybeRelative } from "../analysis/pathUtils";
import { resolveIndexPath } from "../analysis/store";

export interface ExtensionSettings {
  workspaceRoot: string;
  projectFile: string;
  threadMapFile?: string;
  outputDir: string;
  indexPath: string;
  excludeGlobs: string[];
  maxGraphDepth: number;
  maxIndexWorkers: number;
  parserMode: "standard" | "custom";
}

export async function readSettings(context: vscode.ExtensionContext): Promise<ExtensionSettings> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("VC6プロジェクトルートをVS Codeで開いてください。");
  }

  const workspaceRoot = normalizePath(workspaceFolder.uri.fsPath);
  const config = vscode.workspace.getConfiguration("vc6Impact");
  const projectFileSetting = config.get<string>("projectFile") ?? "";
  const detectedProjectFile = projectFileSetting.trim()
    ? resolveMaybeRelative(workspaceRoot, projectFileSetting)
    : await findDefaultProjectFile(workspaceRoot);
  if (!detectedProjectFile) {
    throw new Error(".dsw または .dsp がワークスペース直下に見つかりません。vc6Impact.projectFile を設定してください。");
  }

  const outputDirSetting = config.get<string>("outputDir") ?? "";
  const outputDir = outputDirSetting.trim()
    ? resolveMaybeRelative(workspaceRoot, outputDirSetting)
    : normalizePath(path.join(context.globalStorageUri.fsPath, path.basename(workspaceRoot)));
  const indexPath = resolveIndexPath(
    outputDir,
    config.get<string>("indexDbPath")?.trim()
      ? resolveMaybeRelative(workspaceRoot, config.get<string>("indexDbPath") ?? "")
      : undefined
  );
  const threadMapSetting = config.get<string>("threadMapFile") ?? "";

  return {
    workspaceRoot,
    projectFile: detectedProjectFile,
    threadMapFile: threadMapSetting.trim() ? resolveMaybeRelative(workspaceRoot, threadMapSetting) : undefined,
    outputDir,
    indexPath,
    excludeGlobs: config.get<string[]>("excludeGlobs") ?? [],
    maxGraphDepth: config.get<number>("maxGraphDepth") ?? 4,
    maxIndexWorkers: config.get<number>("maxIndexWorkers") ?? 0,
    parserMode: config.get<"standard" | "custom">("parserMode") === "custom" ? "custom" : "standard"
  };
}
