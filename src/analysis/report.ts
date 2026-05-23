import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderGraphHtml } from "./renderGraph";
import { reportArtifactDisplayPath, reportDisplayPath, reportRelativeLink } from "./store";
import type { AnalysisIndex, ImpactResult, SourceLocation } from "./types";

export interface MarkdownReportOptions {
  markdownPath?: string;
  htmlPath?: string;
}

export async function writeReviewReport(
  index: AnalysisIndex,
  impact: ImpactResult,
  markdownPath: string,
  htmlPath: string
): Promise<void> {
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(markdownPath, renderMarkdownReport(index, impact, { markdownPath, htmlPath }), "utf8");
  await fs.writeFile(htmlPath, renderGraphHtml(impact, { workspaceRoot: index.workspaceRoot, mode: "standalone" }), "utf8");
}

export function renderMarkdownReport(
  index: AnalysisIndex,
  impact: ImpactResult,
  options: MarkdownReportOptions | string = {}
): string {
  const reportOptions: MarkdownReportOptions = typeof options === "string" ? { htmlPath: options } : options;
  const lines: string[] = [];
  lines.push(`# 変更影響レビュー: ${impact.symbolName}`);
  lines.push("");
  lines.push(`- 種別: ${kindLabel(impact.symbolKind)}`);
  lines.push(`- 生成日時: ${index.generatedAt}`);
  lines.push(`- 対象プロジェクト: \`${reportDisplayPath(index.workspaceRoot, index.projectFile)}\``);
  lines.push(`- 解析ファイル数: ${index.build.sourceFileCount}`);
  lines.push(`- 索引更新方式: ${index.build.mode}${index.build.fullRebuildReason ? ` (${index.build.fullRebuildReason})` : ""}`);
  lines.push(`- 処理時間: ${index.build.durationMs} ms`);
  lines.push(`- worker数: ${index.build.workerCount}`);
  lines.push(`- phase別時間: ${formatPhaseDurations(index.build.phaseDurationsMs)}`);
  if (reportOptions.htmlPath) {
    const outputDir = reportOptions.markdownPath
      ? path.dirname(path.dirname(reportOptions.markdownPath))
      : path.dirname(path.dirname(reportOptions.htmlPath));
    const label = reportArtifactDisplayPath(outputDir, reportOptions.htmlPath);
    const href = reportOptions.markdownPath
      ? reportRelativeLink(reportOptions.markdownPath, reportOptions.htmlPath)
      : label;
    lines.push(`- HTML図: [${label}](${href})`);
  }
  lines.push("");

  lines.push("## 変数/関数");
  if (impact.globals.length > 0) {
    for (const global of impact.globals) {
      lines.push(`- global \`${global.name}\`: ${formatLocation(global.file, global.line, index.workspaceRoot, reportOptions.markdownPath)} / \`${global.declaration}\``);
    }
  }
  if (impact.members.length > 0) {
    for (const member of impact.members) {
      lines.push(`- member \`${member.name}\`: ${formatLocation(member.file, member.line, index.workspaceRoot, reportOptions.markdownPath)} / \`${member.declaration}\``);
    }
  }
  if (impact.macros.length > 0) {
    for (const macro of impact.macros) {
      lines.push(`- macro \`${macro.name}\`: ${formatLocation(macro.file, macro.line, index.workspaceRoot, reportOptions.markdownPath)} / 展開先 \`${macro.targetName}\` / \`${macro.declaration}\``);
    }
  }
  if (impact.symbolKind === "function") {
    for (const func of impact.functions.filter((func) => func.name === impact.symbolName)) {
      lines.push(`- function \`${func.name}\`: ${formatLocation(func.file, func.startLine, index.workspaceRoot, reportOptions.markdownPath)} / \`${func.signature}\``);
    }
  }
  if (impact.symbolKind === "unknown") {
    lines.push("- 索引内に一致するglobal/functionがありません。");
  }
  lines.push("");

  lines.push("## スレッド到達候補");
  if (impact.threadContexts.length === 0) {
    lines.push("- thread mapから到達する関数は見つかりませんでした。");
  } else {
    for (const context of impact.threadContexts) {
      const interrupt = context.interruptLikeThreadIds.length > 0
        ? ` / 割込み系: ${context.interruptLikeThreadIds.join(", ")}`
        : "";
      lines.push(`- \`${context.functionName}\`: ${context.threadIds.join(", ")}${interrupt}`);
    }
  }
  lines.push("");

  lines.push("## 参照/更新箇所");
  if (impact.accesses.length === 0) {
    lines.push("- 対象に紐づくread/write候補はありません。");
  } else {
    for (const access of impact.accesses) {
      lines.push(
        `- ${access.kind.toUpperCase()} \`${access.variableName}\` in \`${access.functionName}\` at ${formatLocation(
          access.location.file,
          access.location.line,
          index.workspaceRoot,
          reportOptions.markdownPath
        )}: \`${access.evidence}\``
      );
      if (access.expandedEvidence && access.expandedEvidence !== access.evidence) {
        lines.push(`  - 展開後: \`${access.expandedEvidence}\``);
      }
      if (access.macroNames?.length) {
        lines.push(`  - macro: ${access.macroNames.map((name) => `\`${name}\``).join(", ")}`);
      }
    }
  }
  lines.push("");

  lines.push("## 干渉リスク候補");
  if (impact.risks.length === 0) {
    lines.push("- 自動抽出された干渉リスク候補はありません。これは安全証明ではありません。");
  } else {
    for (const risk of impact.risks) {
      lines.push(`- [${risk.severity}] ${risk.title} (${risk.code})`);
      lines.push(`  - ${risk.detail}`);
      lines.push(`  - 根拠: ${formatEvidence(risk.evidence, index.workspaceRoot, reportOptions.markdownPath)}`);
    }
  }
  lines.push("");

  lines.push("## 未解決要素");
  if (impact.unresolved.length === 0) {
    lines.push("- 未解決要素は検出されませんでした。");
  } else {
    for (const item of impact.unresolved) {
      lines.push(
        `- ${item.kind}: ${formatLocation(item.location.file, item.location.line, index.workspaceRoot, reportOptions.markdownPath)} / ${item.note} / \`${item.evidence}\``
      );
    }
  }
  lines.push("");

  lines.push("## レビュー上の注意");
  lines.push("- 本資料は静的解析による候補抽出です。ロック安全性、リアルタイム実行順序、安全性を断定しません。");
  lines.push("- `未分類` または `未解決` が残る箇所は、人手レビューで更新順序と割込み制約を確認してください。");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function kindLabel(kind: ImpactResult["symbolKind"]): string {
  if (kind === "global") {
    return "グローバル変数";
  }
  if (kind === "member") {
    return "構造体メンバ";
  }
  if (kind === "macro") {
    return "macro alias";
  }
  if (kind === "function") {
    return "関数";
  }
  return "未特定";
}

function formatEvidence(locations: SourceLocation[], workspaceRoot: string, markdownPath?: string): string {
  const unique = new Map<string, SourceLocation>();
  for (const location of locations) {
    unique.set(`${location.file}:${location.line}`, location);
  }
  return [...unique.values()]
    .slice(0, 12)
    .map((location) => formatLocation(location.file, location.line, workspaceRoot, markdownPath))
    .join(", ");
}

function formatPhaseDurations(phases: Record<string, number> | undefined): string {
  if (!phases) {
    return "未記録";
  }
  return Object.entries(phases)
    .map(([phase, ms]) => `${phase}=${ms}ms`)
    .join(", ");
}

function formatLocation(file: string, line: number, workspaceRoot: string, markdownPath?: string): string {
  const label = `${reportDisplayPath(workspaceRoot, file)}:${line}`;
  const href = markdownPath
    ? reportRelativeLink(markdownPath, file, line)
    : `${reportDisplayPath(workspaceRoot, file)}#L${line}`;
  return `[${label}](${href})`;
}
