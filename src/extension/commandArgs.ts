export function normalizeCommandSymbolArg(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeNonEmpty(value);
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
    normalizeNonEmpty(candidate.symbolName) ??
    normalizeNonEmpty(candidate.name) ??
    normalizeLabel(candidate.label)
  );
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeNonEmpty(value);
  }
  if (value && typeof value === "object" && "label" in value) {
    return normalizeNonEmpty((value as { label?: unknown }).label);
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
