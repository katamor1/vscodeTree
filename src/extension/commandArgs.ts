export function normalizeCommandSymbolArg(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeSymbolText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as {
    symbolName?: unknown;
    name?: unknown;
    label?: unknown;
  };
  return (
    normalizeSymbolText(candidate.symbolName) ??
    normalizeSymbolText(candidate.name) ??
    normalizeLabel(candidate.label)
  );
}

export function extractSymbolAtTextOffset(text: string, offset: number): string | undefined {
  const boundedOffset = Math.max(0, Math.min(text.length, offset));
  for (const match of text.matchAll(/\b[A-Za-z_]\w*(?:\s*\[[^\]]+\])?\s*(?:\.|->)\s*[A-Za-z_]\w*(?:\s*\[[^\]]+\])?(?:(?:\s*(?:\.|->)\s*)[A-Za-z_]\w*(?:\s*\[[^\]]+\])?)*/g)) {
    if (match.index === undefined) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (boundedOffset >= start && boundedOffset <= end) {
      return normalizeMemberSymbol(match[0]);
    }
  }

  let start = boundedOffset;
  while (start > 0 && isIdentifierPart(text[start - 1])) {
    start -= 1;
  }
  let end = boundedOffset;
  while (end < text.length && isIdentifierPart(text[end])) {
    end += 1;
  }
  return normalizeNonEmpty(text.slice(start, end));
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeSymbolText(value);
  }
  if (value && typeof value === "object" && "label" in value) {
    return normalizeSymbolText((value as { label?: unknown }).label);
  }
  return undefined;
}

function normalizeNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMemberSymbol(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, "").replace(/\[[^\]]+\]/g, "[]");
  return normalizeNonEmpty(normalized);
}

function normalizeSymbolText(value: unknown): string | undefined {
  const trimmed = normalizeNonEmpty(value);
  if (!trimmed) {
    return undefined;
  }
  return /(?:\.|->)/.test(trimmed) ? normalizeMemberSymbol(trimmed) : trimmed;
}

function isIdentifierPart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_]/.test(char));
}
