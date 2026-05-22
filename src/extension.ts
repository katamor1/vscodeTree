import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { buildImpact } from "./analysis/impact";
import { buildFullIndex, updateIndex } from "./analysis/indexer";
import { reportPaths, readIndex, writeIndex } from "./analysis/store";
import { writeReviewReport } from "./analysis/report";
import type { AnalysisIndex, ImpactResult } from "./analysis/types";
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
            return buildFullIndex(settings);
          }
        );
        await writeIndex(settings.indexPath, index);
        treeProvider.setStatus(`Index built: ${index.build.sourceFileCount} files, ${index.build.durationMs} ms`);
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
            return updateIndex(settings, previous);
          }
        );
        await writeIndex(settings.indexPath, index);
        treeProvider.setStatus(
          `Index updated: changed ${index.build.changedFiles.length}, reused ${index.build.reusedFiles}, ${index.build.durationMs} ms`
        );
        vscode.window.showInformationMessage(`VC6 Impact index updated: ${settings.indexPath}`);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.inspectSelectedSymbol", async (symbolArg?: string) => {
      await withErrors(async () => {
        const { index, symbolName, settings } = await loadIndexAndSymbol(context, symbolArg);
        currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
        treeProvider.setImpact(currentImpact);
        graphView.show(context, currentImpact);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.generateReviewReport", async (symbolArg?: string) => {
      await withErrors(async () => {
        const { index, symbolName, settings } = await loadIndexAndSymbol(context, symbolArg);
        currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
        treeProvider.setImpact(currentImpact);
        const paths = reportPaths(settings.outputDir, symbolName);
        await writeReviewReport(index, currentImpact, paths.markdown, paths.html);
        const document = await vscode.workspace.openTextDocument(paths.markdown);
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(`Review report generated: ${paths.markdown}`);
      });
    }),
    vscode.commands.registerCommand("vc6Impact.openGraph", async (symbolArg?: string) => {
      await withErrors(async () => {
        if (!currentImpact || symbolArg) {
          const { index, symbolName, settings } = await loadIndexAndSymbol(context, symbolArg);
          currentImpact = buildImpact(index, symbolName, settings.maxGraphDepth);
          treeProvider.setImpact(currentImpact);
        }
        graphView.show(context, currentImpact);
      });
    })
  );
}

export function deactivate(): void {
  currentImpact = undefined;
}

async function loadIndexAndSymbol(
  context: vscode.ExtensionContext,
  symbolArg?: string
): Promise<{ index: AnalysisIndex; symbolName: string; settings: Awaited<ReturnType<typeof readSettings>> }> {
  const settings = await readSettings(context);
  const index = await readIndex(settings.indexPath);
  if (!index) {
    throw new Error(`索引がありません。先に Build Full Index を実行してください: ${settings.indexPath}`);
  }
  const symbolName = symbolArg || getSelectedSymbol() || (await vscode.window.showInputBox({ prompt: "Inspect symbol name" }));
  if (!symbolName?.trim()) {
    throw new Error("対象シンボル名が指定されていません。");
  }
  await fs.mkdir(settings.outputDir, { recursive: true });
  return { index, symbolName: symbolName.trim(), settings };
}

function getSelectedSymbol(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const selection = editor.selection;
  const range = selection.isEmpty
    ? editor.document.getWordRangeAtPosition(selection.active, /[A-Za-z_]\w*(?:::[A-Za-z_]\w*)?/)
    : selection;
  return range ? editor.document.getText(range).trim() : undefined;
}

async function withErrors(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`VC6 Impact: ${message}`);
  }
}
