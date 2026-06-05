import type { UnresolvedEvidence } from "./types";

export function isFunctionTopologyUnresolved(kind: UnresolvedEvidence["kind"]): boolean {
  return kind === "function-pointer" || kind === "unknown-call";
}
