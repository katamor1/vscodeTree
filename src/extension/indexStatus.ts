export interface IndexStatusSummary {
  action: "built" | "updated" | "loaded";
  sourceFileCount?: number;
  changedFileCount?: number;
  reusedFileCount?: number;
  skippedFileCount?: number;
  durationMs: number;
  workerCount: number;
}

export interface IndexStatusLine {
  label: string;
  description: string;
  icon: string;
}

export function formatIndexStatusLines(status: IndexStatusSummary): IndexStatusLine[] {
  const lines: IndexStatusLine[] = [
    {
      label: status.action === "built" ? "Index built" : status.action === "loaded" ? "Index loaded" : "Index updated",
      description: status.action === "loaded" ? "from disk" : "ready",
      icon: status.action === "loaded" ? "database" : "check"
    }
  ];

  if (typeof status.sourceFileCount === "number") {
    lines.push({ label: "Files", description: formatInteger(status.sourceFileCount), icon: "files" });
  }
  if (typeof status.changedFileCount === "number") {
    lines.push({ label: "Changed", description: formatInteger(status.changedFileCount), icon: "diff" });
  }
  if (typeof status.reusedFileCount === "number") {
    lines.push({ label: "Reused", description: formatInteger(status.reusedFileCount), icon: "history" });
  }
  if (typeof status.skippedFileCount === "number" && status.skippedFileCount > 0) {
    lines.push({ label: "Skipped", description: formatInteger(status.skippedFileCount), icon: "warning" });
  }

  lines.push(
    { label: "Time", description: formatDuration(status.durationMs), icon: "clock" },
    { label: "Workers", description: formatInteger(status.workerCount), icon: "server-process" }
  );

  return lines;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
