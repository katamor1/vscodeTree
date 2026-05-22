import * as fs from "node:fs/promises";
import { resolveMaybeRelative } from "./pathUtils";
import type { ThreadDefinition, ThreadMap } from "./types";

export async function readThreadMap(workspaceRoot: string, threadMapFile?: string): Promise<ThreadMap> {
  if (!threadMapFile?.trim()) {
    return { threads: [] };
  }
  const resolved = resolveMaybeRelative(workspaceRoot, threadMapFile);
  const text = await fs.readFile(resolved, "utf8");
  const parsed = text.trim().startsWith("{") ? JSON.parse(text) : parseSimpleYaml(text);
  return normalizeThreadMap(parsed);
}

function normalizeThreadMap(value: unknown): ThreadMap {
  const source = value as { threads?: unknown[] };
  const threads = Array.isArray(source.threads) ? source.threads : [];
  return {
    threads: threads
      .map((thread) => thread as Partial<ThreadDefinition>)
      .filter((thread) => typeof thread.threadId === "string" && typeof thread.entryFunction === "string")
      .map((thread) => ({
        threadId: thread.threadId!.trim(),
        entryFunction: thread.entryFunction!.trim(),
        priority: stringifyOptional(thread.priority),
        cycle: stringifyOptional(thread.cycle),
        isInterruptLike: Boolean(thread.isInterruptLike),
        notes: stringifyOptional(thread.notes)
      }))
  };
}

function stringifyOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function parseSimpleYaml(text: string): ThreadMap {
  const threads: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim() === "threads:") {
      continue;
    }
    const itemMatch = /^\s*-\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (itemMatch) {
      current = {};
      threads.push(current);
      current[itemMatch[1]] = parseScalar(itemMatch[2]);
      continue;
    }
    const propertyMatch = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (propertyMatch && current) {
      current[propertyMatch[1]] = parseScalar(propertyMatch[2]);
    }
  }

  return { threads: threads as unknown as ThreadDefinition[] };
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (/^(true|false)$/i.test(trimmed)) {
    return /^true$/i.test(trimmed);
  }
  return trimmed;
}
