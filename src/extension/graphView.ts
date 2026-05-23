import * as vscode from "vscode";
import { renderGraphHtml } from "../analysis/renderGraph";
import type { ImpactResult } from "../analysis/types";
import { normalizeOpenLocationMessage } from "./openLocationMessage";

export class GraphView {
  private panel: vscode.WebviewPanel | undefined;
  private messageSubscription: vscode.Disposable | undefined;

  show(context: vscode.ExtensionContext, impact: ImpactResult, workspaceRoot: string): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "vc6ImpactGraph",
        "VC6 Impact Graph",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [context.globalStorageUri]
        }
      );
      this.messageSubscription = this.panel.webview.onDidReceiveMessage(async (message) => {
        const location = normalizeOpenLocationMessage(message);
        if (!location) {
          return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.file));
        const line = Math.max(0, location.line - 1);
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(line, 0, line, 0),
          preserveFocus: false
        });
      });
      this.panel.onDidDispose(() => {
        this.messageSubscription?.dispose();
        this.messageSubscription = undefined;
        this.panel = undefined;
      });
    }
    this.panel.title = `Impact: ${impact.symbolName}`;
    this.panel.webview.html = renderGraphHtml(impact, {
      workspaceRoot,
      mode: "webview",
      nonce: createNonce()
    });
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
