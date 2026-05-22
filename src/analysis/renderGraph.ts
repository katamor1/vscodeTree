import type { ImpactResult } from "./types";

export function renderGraphHtml(impact: ImpactResult): string {
  const nodes = impact.graph.nodes;
  const edges = impact.graph.edges;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VC6 Impact Graph - ${escapeHtml(impact.symbolName)}</title>
  <style>
    :root { color-scheme: light dark; font-family: "Segoe UI", sans-serif; }
    body { margin: 0; padding: 24px; background: #f8fafc; color: #111827; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    .summary { margin: 0 0 20px; color: #475569; }
    .layout { display: grid; grid-template-columns: minmax(280px, 1.2fr) minmax(320px, 1fr); gap: 18px; align-items: start; }
    .panel { background: #fff; border: 1px solid #dbe3ef; border-radius: 8px; padding: 16px; }
    .node { display: inline-flex; align-items: center; margin: 6px; padding: 7px 10px; border-radius: 6px; border: 1px solid #cbd5e1; background: #f8fafc; font-size: 13px; }
    .target { border-color: #0ea5e9; background: #e0f2fe; font-weight: 700; }
    .thread { border-color: #10b981; background: #d1fae5; }
    .risk { border-color: #f97316; background: #ffedd5; }
    .unresolved { border-color: #a855f7; background: #f3e8ff; }
    .function { border-color: #64748b; background: #f1f5f9; }
    .global { border-color: #0284c7; background: #e0f2fe; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { color: #475569; font-weight: 600; }
    code { font-family: Consolas, monospace; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      .summary { color: #cbd5e1; }
      .panel { background: #1f2937; border-color: #374151; }
      th, td { border-bottom-color: #374151; }
      .node { color: #111827; }
    }
  </style>
</head>
<body>
  <h1>変更影響グラフ: ${escapeHtml(impact.symbolName)}</h1>
  <p class="summary">Graph nodes: ${nodes.length}, edges: ${edges.length}. これは候補可視化であり、安全性の断定ではありません。</p>
  <div class="layout">
    <section class="panel">
      <h2>Nodes</h2>
      ${nodes.map((node) => `<span class="node ${node.kind}">${escapeHtml(node.label)}</span>`).join("\n")}
    </section>
    <section class="panel">
      <h2>Edges</h2>
      <table>
        <thead><tr><th>From</th><th>Label</th><th>To</th></tr></thead>
        <tbody>
          ${edges
            .map(
              (edge) =>
                `<tr><td><code>${escapeHtml(edge.from)}</code></td><td>${escapeHtml(edge.label)}</td><td><code>${escapeHtml(edge.to)}</code></td></tr>`
            )
            .join("\n")}
        </tbody>
      </table>
    </section>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
