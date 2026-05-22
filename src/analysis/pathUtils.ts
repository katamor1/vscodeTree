import * as path from "node:path";

export function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
}

export function resolveMaybeRelative(baseDir: string, value: string): string {
  if (!value.trim()) {
    return value;
  }
  const normalized = value.replace(/^"|"$/g, "").replace(/\\/g, path.sep);
  return path.isAbsolute(normalized)
    ? normalizePath(normalized)
    : normalizePath(path.resolve(baseDir, normalized));
}

export function toWorkspaceRelative(workspaceRoot: string, file: string): string {
  const relative = path.relative(workspaceRoot, file);
  return relative && !relative.startsWith("..") ? relative.replace(/\\/g, "/") : file;
}

export function matchesExcluded(file: string, excludeGlobs: string[] = []): boolean {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return excludeGlobs.some((glob) => {
    const needle = glob
      .replace(/\\/g, "/")
      .replace(/^\*\*\//, "")
      .replace(/\/\*\*$/, "")
      .replace(/\*/g, "")
      .toLowerCase();
    return needle.length > 0 && normalized.includes(needle);
  });
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "symbol";
}
