import * as vscode from "vscode";
import type { ImpactResult, SourceLocation } from "../analysis/types";

type NodeKind = "message" | "risk" | "thread" | "access" | "unresolved" | "function";

class ImpactItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: NodeKind,
    public readonly children: ImpactItem[] = [],
    location?: SourceLocation
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    this.tooltip = label;
    if (location) {
      this.description = `${location.file}:${location.line}`;
      this.command = {
        command: "vscode.open",
        title: "Open Location",
        arguments: [vscode.Uri.file(location.file), { selection: new vscode.Range(location.line - 1, 0, location.line - 1, 0) }]
      };
    }
  }
}

export class ImpactTreeProvider implements vscode.TreeDataProvider<ImpactItem> {
  private readonly changed = new vscode.EventEmitter<ImpactItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private impact: ImpactResult | undefined;
  private status = "Build an index, then inspect a symbol.";

  setStatus(status: string): void {
    this.status = status;
    this.impact = undefined;
    this.changed.fire();
  }

  setImpact(impact: ImpactResult): void {
    this.impact = impact;
    this.status = "";
    this.changed.fire();
  }

  getTreeItem(element: ImpactItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ImpactItem): ImpactItem[] {
    if (element) {
      return element.children;
    }
    if (!this.impact) {
      return [new ImpactItem(this.status, vscode.TreeItemCollapsibleState.None, "message")];
    }
    return [
      new ImpactItem(`Target: ${this.impact.symbolName} (${this.impact.symbolKind})`, vscode.TreeItemCollapsibleState.None, "message"),
      new ImpactItem(
        `Risks (${this.impact.risks.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
        "risk",
        this.impact.risks.map(
          (risk) => new ImpactItem(`[${risk.severity}] ${risk.title}`, vscode.TreeItemCollapsibleState.None, "risk", [], risk.evidence[0])
        )
      ),
      new ImpactItem(
        `Thread Contexts (${this.impact.threadContexts.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "thread",
        this.impact.threadContexts.map(
          (context) =>
            new ImpactItem(
              `${context.functionName}: ${context.threadIds.join(", ") || "未分類"}`,
              vscode.TreeItemCollapsibleState.None,
              "thread"
            )
        )
      ),
      new ImpactItem(
        `Accesses (${this.impact.accesses.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "access",
        this.impact.accesses.map(
          (access) =>
            new ImpactItem(
              `${access.kind.toUpperCase()} ${access.variableName} in ${access.functionName}`,
              vscode.TreeItemCollapsibleState.None,
              "access",
              [],
              access.location
            )
        )
      ),
      new ImpactItem(
        `Functions (${this.impact.functions.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "function",
        this.impact.functions.map(
          (func) =>
            new ImpactItem(
              `${func.name} (${func.calls.length} calls)`,
              vscode.TreeItemCollapsibleState.None,
              "function",
              [],
              { file: func.file, line: func.startLine }
            )
        )
      ),
      new ImpactItem(
        `Unresolved (${this.impact.unresolved.length})`,
        vscode.TreeItemCollapsibleState.Collapsed,
        "unresolved",
        this.impact.unresolved.map(
          (item) =>
            new ImpactItem(
              `${item.kind}: ${item.note}`,
              vscode.TreeItemCollapsibleState.None,
              "unresolved",
              [],
              item.location
            )
        )
      )
    ];
  }
}
