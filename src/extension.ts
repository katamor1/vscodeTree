import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { buildImpact } from "./analysis/impact";
import { buildFullIndexToStorage, updateIndexToStorage } from "./analysis/indexer";
import { ensureArtifactIgnored, readIndexBuildSummary, reportPaths, readIndex, readIndexForSymbol } from "./analysis/store";
import { writeReviewReport } from "./analysis/report";
import type { AnalysisIndex, ImpactResult } from "./analysis/types";
import { extractSymbolAtTextOffset, normalizeCommandSymbolArg } from "./extension/commandArgs";
import { ImpactTreeProvider } from "./extension/impactTree";
import { GraphView } from "./extension/graphView";
import { readSettings } from "./extension/settings";

let currentImpact: ImpactResult | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const treeProvider = new ImpactTreeProvider();
  const graphView = new GraphView();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("vc6Impact.explorer", treeProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand("vc6Impact.buildFullIndex", async () => {
      await withErrors(async () => {
        const settings = await readSettings(context);
        const index = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "VC6 Impact: building full index", cancellable: false },
          async (progress) => {
            progress.report({ message: "Parsing DSW/DSP and scanning source files..." });
            return buildFullIndexToStorage(settings, settings.indexPath);
          }
        );
        await ensureArtifactIgnored(settings.workspaceRoot, settings.outputDir);
        treeProvider.setIndexStatus({
          action: "built",
          sourceFileCount: index.build.sourceFileCount,
          durationMs: index.build.durationMs,
          workerCount: index.build.workerCount
        });
        vscode.window.showInformationMessage(`VC6 Impact index built: ${settings.indexPath}`);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.updateIndex", async () => {
      await withErrors(async () => {
        const settings = await readSettings(context);
        const previous = await readIndex(settings.indexPath);
        const index = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "VC6 Impact: updating index", cancellable: false },
          async (progress) => {
            progress.report({ message: "Checking changed files..." });
            return updateIndexToStorage(settings, previous, settings.indexPath);
          }
        );
        await ensureArtifactIgnored(settings.workspaceRoot, settings.outputDir);
        treeProvider.setIndexStatus({
          action: "updated",
          sourceFileCount: index.build.sourceFileCount,
          changedFileCount: index.build.changedFiles.length,
          reusedFileCount: index.build.reusedFiles,
          durationMs: index.build.durationMs,
          workerCount: index.build.workerCount
        });
        vscode.window.showInformationMessage(`VC6 Impact index updated: ${settings.indexPath}`);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.inspectSelectedSymbol", async (symbolArg?: unknown) => {
      await withErrors(async () => {
        const { index, symbolName, settings } = await loadIndexAndSymbol(context, symbolArg);
        currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
        treeProvider.setImpact(currentImpact);
        graphView.show(context, currentImpact, settings.workspaceRoot);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.generateReviewReport", async (symbolArg?: unknown) => {
      await withErrors(async () => {
        const { index, symbolName, settings } = await loadIndexAndSymbol(context, symbolArg);
        currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
        treeProvider.setImpact(currentImpact);
        const paths = reportPaths(settings.outputDir, symbolName);
        await ensureArtifactIgnored(settings.workspaceRoot, settings.outputDir);
        await writeReviewReport(index, currentImpact, paths.markdown, paths.html);
        const document = await vscode.workspace.openTextDocument(paths.markdown);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(`Review report generated: ${paths.markdown}`);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.openGraph", async (symbolArg?: unknown) => {
      await withErrors(async () => {
        const normalizedArg = normalizeCommandSymbolArg(symbolArg);
        if (!currentImpact || normalizedArg) {
          const { index, symbolName, settings } = await loadIndexAndSymbol(context, normalizedArg);
          currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
          treeProvider.setImpact(currentImpact);
        }
        const settings = await readSettings(context);
        graphView.show(context, currentImpact, settings.workspaceRoot);
      });
    })
  );

  void restoreExistingIndexStatus(context, treeProvider);
}

export function deactivate(): void {
  currentImpact = undefined;
}

async function loadIndexAndSymbol(
  context: vscode.ExtensionContext,
  symbolArg?: unknown
): Promise<{ index: AnalysisIndex; symbolName: string; settings: Awaited<ReturnType<typeof readSettings>> }> {
  const settings = await readSettings(context);
  const symbolName =
    normalizeCommandSymbolArg(symbolArg) ??
    normalizeCommandSymbolArg(getSelectedSymbol()) ??
    normalizeCommandSymbolArg(await vscode.window.showInputBox({ prompt: "Inspect symbol name" }));
  if (!symbolName) {
    throw new Error("対象シンボル名が指定されていません。");
  }
  const index = await readIndexForSymbol(settings.indexPath, symbolName, settings.maxGraphDepth);
  if (!index) {
    throw new Error(`索引がありません。先に Build Full Index を実行してください: ${settings.indexPath}`);
  }
  await fs.mkdir(settings.outputDir, { recursive: true });
  return { index, symbolName, settings };
}

async function restoreExistingIndexStatus(context: vscode.ExtensionContext, treeProvider: ImpactTreeProvider): Promise<void> {
  try {
    const settings = await readSettings(context);
    const summary = await readIndexBuildSummary(settings.indexPath);
    if (!summary) {
      return;
    }
    treeProvider.setIndexStatus({
      action: "loaded",
      sourceFileCount: summary.sourceFileCount,
      durationMs: summary.durationMs,
      workerCount: summary.workerCount
    });
  } catch (error) {
    console.warn("VC6 Impact: existing index status was not restored", error);
  }
}

function getSelectedSymbol(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return editor.document.getText(selection).trim();
  }
  const line = editor.document.lineAt(selection.active.line).text;
  return extractSymbolAtTextOffset(line, selection.active.character);
}

async function withErrors(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`VC6 Impact: ${message}`);
  }
}
