import * as path from "node:path";
import type { ImpactResult, SourceLocation } from "./types";

export interface RenderGraphOptions {
  workspaceRoot?: string;
  mode?: "standalone" | "webview";
  nonce?: string;
}

export function renderGraphHtml(impact: ImpactResult, options: RenderGraphOptions = {}): string {
  const mode = options.mode ?? "standalone";
  const nonce = options.nonce ?? "";
  const targetFunctions = impact.functions.filter((func) => func.name === impact.symbolName);
  const nodesById = new Map(impact.graph.nodes.map((node) => [node.id, node.label]));

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${mode === "webview" ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';">` : ""}
  <title>VC6 Impact Graph - ${escapeHtml(impact.symbolName)}</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: #f8fafc; color: #111827; font-size: 13px; }
    h1 { font-size: 20px; margin: 0 0 4px; line-height: 1.25; }
    h2 { font-size: 15px; margin: 0 0 10px; }
    h3 { font-size: 13px; margin: 0; }
    .subtitle { margin: 0; color: #64748b; }
    .shell { width: 100%; max-width: 1280px; margin: 0 auto; }
    .header { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin-bottom: 12px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .metric { border: 1px solid #dbe3ef; border-radius: 6px; background: #fff; padding: 9px 10px; min-width: 0; }
    .metric .label { color: #64748b; font-size: 11px; text-transform: uppercase; }
    .metric .value { display: block; margin-top: 2px; font-size: 18px; font-weight: 700; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
    .panel { background: #fff; border: 1px solid #dbe3ef; border-radius: 6px; padding: 12px; min-width: 0; overflow: hidden; }
    .section-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 7px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
    th { color: #475569; font-weight: 600; font-size: 12px; }
    tr:last-child td { border-bottom: 0; }
    code, .code { font-family: Consolas, "Courier New", monospace; font-size: 12px; }
    .access-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
    .access-card { border: 1px solid #e5e7eb; border-radius: 6px; background: #fff; padding: 10px; min-width: 0; }
    .access-card-head { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(130px, auto); gap: 8px; align-items: start; }
    .access-function { font-weight: 700; overflow-wrap: anywhere; }
    .access-location { text-align: right; min-width: 0; }
    .access-fields { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 5px 10px; margin: 8px 0 0; }
    .access-fields dt { color: #64748b; font-size: 12px; }
    .access-fields dd { margin: 0; overflow-wrap: anywhere; }
    .access-evidence { line-height: 1.45; }
    .kind { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid #cbd5e1; background: #f8fafc; white-space: nowrap; }
    .kind.write, .severity-high { border-color: #fb923c; background: #ffedd5; }
    .kind.read, .severity-info { border-color: #38bdf8; background: #e0f2fe; }
    .kind.unknown, .severity-warning { border-color: #c084fc; background: #f3e8ff; }
    .location-link { appearance: none; border: 0; background: transparent; color: #0369a1; padding: 0; font: inherit; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
    .location-link:hover { text-decoration: underline; }
    .empty { margin: 0; color: #64748b; }
    details summary { cursor: pointer; color: #334155; font-weight: 600; }
    .edge-list { margin-top: 8px; max-height: 220px; overflow: auto; }
    @media (min-width: 1100px) { .header { grid-template-columns: minmax(0, 1.4fr) minmax(360px, .8fr); align-items: start; } }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      .subtitle, .empty, .metric .label { color: #cbd5e1; }
      .panel, .metric, .access-card { background: #1f2937; border-color: #374151; }
      .access-fields dt { color: #cbd5e1; }
      th, td { border-bottom-color: #374151; }
      .location-link { color: #7dd3fc; }
      details summary { color: #e5e7eb; }
      .kind { color: #111827; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="header">
      <div>
        <h1>変更影響グラフ: ${escapeHtml(impact.symbolName)}</h1>
        <p class="subtitle">候補可視化です。安全性やリアルタイム順序は断定しません。</p>
      </div>
      <div class="summary-grid">
        ${metric("Declarations", impact.globals.length + impact.members.length + impact.macros.length + targetFunctions.length)}
        ${metric("Accesses", impact.accesses.length)}
        ${metric("Risks", impact.risks.length)}
        ${metric("Unresolved", impact.unresolved.length)}
      </div>
    </section>

    <div class="layout">
      <div class="section-grid">
        <section class="panel">
          <h2>宣言</h2>
          ${renderDeclarations(impact, targetFunctions, options)}
        </section>
        <section class="panel">
          <h2>Read / Writeアクセス</h2>
          ${renderAccesses(impact, options)}
        </section>
        <section class="panel">
          <h2>スレッド到達</h2>
          ${renderThreadContexts(impact)}
        </section>
        <section class="panel">
          <h2>未解決 / リスク</h2>
          ${renderRiskAndUnresolved(impact, options)}
        </section>
      </div>

      <section class="panel">
        <details>
          <summary>関係エッジ (${impact.graph.edges.length})</summary>
          <div class="edge-list table-wrap">
            <table>
              <thead><tr><th style="width:40%">From</th><th style="width:20%">Label</th><th style="width:40%">To</th></tr></thead>
              <tbody>
                ${impact.graph.edges
                  .map((edge) => `<tr><td>${escapeHtml(displayGraphRef(edge.from, nodesById))}</td><td>${escapeHtml(edge.label)}</td><td>${escapeHtml(displayGraphRef(edge.to, nodesById))}</td></tr>`)
                  .join("\n")}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  </main>
  ${mode === "webview" ? renderWebviewScript(nonce) : ""}
</body>
</html>`;
}

function renderDeclarations(
  impact: ImpactResult,
  targetFunctions: ImpactResult["functions"],
  options: RenderGraphOptions
): string {
  const rows = [
    ...impact.globals.map(
      (global) =>
        `<tr><td class="code">${escapeHtml(global.name)}</td><td>${locationAction({ file: global.file, line: global.line }, options)}</td><td class="code">${escapeHtml(global.declaration)}</td></tr>`
    ),
    ...impact.members.map(
      (member) =>
        `<tr><td class="code">${escapeHtml(member.name)}</td><td>${locationAction({ file: member.file, line: member.line }, options)}</td><td class="code">${escapeHtml(member.declaration)}</td></tr>`
    ),
    ...impact.macros.map(
      (macro) =>
        `<tr><td class="code">${escapeHtml(macro.name)}</td><td>${locationAction({ file: macro.file, line: macro.line }, options)}</td><td class="code">${escapeHtml(`${macro.declaration} => ${macro.targetName}`)}</td></tr>`
    ),
    ...targetFunctions.map(
      (func) =>
        `<tr><td class="code">${escapeHtml(func.name)}</td><td>${locationAction({ file: func.file, line: func.startLine }, options)}</td><td class="code">${escapeHtml(func.signature)}</td></tr>`
    )
  ];
  return renderTable(["Name", "Location", "Declaration"], rows, "宣言は見つかりませんでした。");
}

function renderAccesses(impact: ImpactResult, options: RenderGraphOptions): string {
  if (impact.symbolKind === "function") {
    return `<p class="empty">関数調査では変数アクセスを展開しません。呼び出し関係とスレッド到達を確認してください。</p>`;
  }
  if (impact.accesses.length === 0) {
    return `<p class="empty">read/write候補はありません。</p>`;
  }
  return `<div class="access-list">${impact.accesses
    .map((access) => {
      const evidence = access.expandedEvidence ? `${access.evidence} => ${access.expandedEvidence}` : access.evidence;
      const macro = access.macroNames?.length ? `<dt>Macro</dt><dd>${escapeHtml(access.macroNames.join(", "))}</dd>` : "";
      return `<article class="access-card">
        <div class="access-card-head">
          <span class="kind ${escapeHtml(access.kind)}">${escapeHtml(access.kind.toUpperCase())}</span>
          <span class="code access-function">${escapeHtml(access.functionName)}</span>
          <span class="access-location">${locationAction(access.location, options)}</span>
        </div>
        <dl class="access-fields">
          <dt>Target</dt><dd class="code">${escapeHtml(access.variableName)}</dd>
          <dt>Evidence</dt><dd class="code access-evidence">${escapeHtml(evidence)}</dd>
          ${macro}
        </dl>
      </article>`;
    })
    .join("\n")}</div>`;
}

function renderThreadContexts(impact: ImpactResult): string {
  const rows = impact.threadContexts.map((context) => {
    const interrupt = context.interruptLikeThreadIds.length > 0 ? context.interruptLikeThreadIds.join(", ") : "";
    return `<tr><td class="code">${escapeHtml(context.functionName)}</td><td>${escapeHtml(context.threadIds.join(", "))}</td><td>${escapeHtml(interrupt)}</td></tr>`;
  });
  return renderTable(["Function", "Threads", "Interrupt-like"], rows, "thread mapから到達する関数はありません。");
}

function renderRiskAndUnresolved(impact: ImpactResult, options: RenderGraphOptions): string {
  const riskRows = impact.risks.map(
    (risk) =>
      `<tr><td><span class="kind severity-${escapeHtml(risk.severity)}">${escapeHtml(risk.severity)}</span></td><td>${escapeHtml(risk.title)}</td><td>${escapeHtml(risk.detail)}</td><td>${risk.evidence.slice(0, 3).map((location) => locationAction(location, options)).join("<br>")}</td></tr>`
  );
  const unresolvedRows = impact.unresolved.map(
    (item) =>
      `<tr><td class="code">${escapeHtml(item.kind)}</td><td>${locationAction(item.location, options)}</td><td>${escapeHtml(item.note)}</td><td class="code">${escapeHtml(item.evidence)}</td></tr>`
  );
  return `${renderTable(["Severity", "Risk", "Detail", "Evidence"], riskRows, "リスク候補はありません。")}
  <h3 style="margin-top:14px">未解決要素</h3>
  ${renderTable(["Kind", "Location", "Note", "Evidence"], unresolvedRows, "未解決要素はありません。")}`;
}

function renderTable(headers: string[], rows: string[], emptyText: string): string {
  if (rows.length === 0) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`;
}

function locationAction(location: SourceLocation, options: RenderGraphOptions): string {
  const label = formatLocation(location, options.workspaceRoot);
  if (options.mode === "webview") {
    return `<button type="button" class="location-link" data-file="${escapeAttribute(location.file)}" data-line="${location.line}">${escapeHtml(label)}</button>`;
  }
  return `<span class="location-link">${escapeHtml(label)}</span>`;
}

function formatLocation(location: SourceLocation, workspaceRoot: string | undefined): string {
  return `${toRelativePath(location.file, workspaceRoot)}:${location.line}`;
}

function toRelativePath(file: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) {
    return file.replace(/\\/g, "/");
  }
  const relative = path.relative(workspaceRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : file.replace(/\\/g, "/");
}

function displayGraphRef(id: string, nodesById: Map<string, string>): string {
  const label = nodesById.get(id);
  if (label) {
    return label;
  }
  return id.replace(/^(target|function|thread|risk|global):/, "");
}

function metric(label: string, value: number): string {
  return `<div class="metric"><span class="label">${escapeHtml(label)}</span><span class="value">${value}</span></div>`;
}

function renderWebviewScript(nonce: string): string {
  return `<script nonce="${escapeAttribute(nonce)}">
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-file][data-line]");
      if (!target) return;
      vscode.postMessage({
        type: "openLocation",
        file: target.dataset.file,
        line: Number(target.dataset.line)
      });
    });
  </script>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string | number): string {
  return escapeHtml(String(value));
}
