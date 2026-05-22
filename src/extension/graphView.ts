import * as vscode from "vscode";
import { renderGraphHtml } from "../analysis/renderGraph";
import type { ImpactResult } from "../analysis/types";

export class GraphView {
  private panel: vscode.WebviewPanel | undefined;

  show(context: vscode.ExtensionContext, impact: ImpactResult): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "vc6ImpactGraph",
        "VC6 Impact Graph",
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
          retainContextWhenHidden: true,
          localResourceRoots: [context.globalStorageUri]
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.panel.title = `Impact: ${impact.symbolName}`;
    this.panel.webview.html = renderGraphHtml(impact);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}
