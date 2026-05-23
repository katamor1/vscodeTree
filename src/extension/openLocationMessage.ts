export interface OpenLocationCommand {
  file: string;
  line: number;
}

export function normalizeOpenLocationMessage(message: unknown): OpenLocationCommand | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const candidate = message as { type?: unknown; file?: unknown; line?: unknown };
  if (candidate.type !== "openLocation" || typeof candidate.file !== "string") {
    return undefined;
  }
  const line = typeof candidate.line === "number" ? candidate.line : Number(candidate.line);
  if (!Number.isFinite(line) || line < 1) {
    return undefined;
  }
  return { file: candidate.file, line: Math.floor(line) };
}
