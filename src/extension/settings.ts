import * as vscode from "vscode";
import { findDefaultProjectFile } from "../analysis/vc6ProjectParser";
import { normalizePath, resolveMaybeRelative } from "../analysis/pathUtils";
import { normalizeParserEngine } from "../analysis/parserBackend";
import { resolveArtifactRoot, resolveIndexPath } from "../analysis/store";
import { normalizeTextEncoding, type TextEncoding } from "../analysis/textEncoding";
import type { ParserEngine } from "../analysis/types";

export interface ExtensionSettings {
  workspaceRoot: string;
  projectFile: string;
  threadMapFile?: string;
  outputDir: string;
  indexPath: string;
  excludeGlobs: string[];
  maxGraphDepth: number;
  maxIndexWorkers: number;
  maxNativeBatchFiles: number;
  parserEngine: ParserEngine;
  projectEncoding: TextEncoding;
  sourceEncoding: TextEncoding;
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
    : resolveArtifactRoot(workspaceRoot);
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
    maxNativeBatchFiles: config.get<number>("maxNativeBatchFiles") ?? 4,
    parserEngine: normalizeParserEngine(config.get<string>("parserEngine"), "rust"),
    projectEncoding: normalizeTextEncoding(config.get<string>("projectEncoding"), "auto"),
    sourceEncoding: normalizeTextEncoding(config.get<string>("sourceEncoding"), "auto")
  };
}
