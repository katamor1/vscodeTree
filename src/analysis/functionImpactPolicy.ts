import type { AnalysisIndex, UnresolvedEvidence } from "./types";

export interface FunctionNeighborhood {
  names: Set<string>;
  callEdges: Set<string>;
}

export function isFunctionTopologyUnresolved(kind: UnresolvedEvidence["kind"]): boolean {
  return kind === "function-pointer" || kind === "unknown-call";
}

export function collectDirectionalFunctionNeighborhood(
  index: Pick<AnalysisIndex, "callGraph" | "calledBy">,
  functionName: string,
  maxDepth: number
): FunctionNeighborhood {
  const depthLimit = Math.max(0, Math.floor(maxDepth));
  const names = new Set<string>([functionName]);
  const callEdges = new Set<string>();

  collectCallees(index, functionName, depthLimit, names, callEdges);
  collectCallers(index, functionName, depthLimit, names, callEdges);

  return { names, callEdges };
}

export function functionCallEdgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function collectCallees(
  index: Pick<AnalysisIndex, "callGraph">,
  functionName: string,
  depthLimit: number,
  names: Set<string>,
  callEdges: Set<string>
): void {
  const visited = new Set<string>();
  const queue: Array<{ name: string; depth: number }> = [{ name: functionName, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.name) || current.depth > depthLimit) {
      continue;
    }
    visited.add(current.name);
    names.add(current.name);
    if (current.depth >= depthLimit) {
      continue;
    }
    for (const called of index.callGraph[current.name] ?? []) {
      names.add(called);
      callEdges.add(functionCallEdgeKey(current.name, called));
      queue.push({ name: called, depth: current.depth + 1 });
    }
  }
}

function collectCallers(
  index: Pick<AnalysisIndex, "calledBy">,
  functionName: string,
  depthLimit: number,
  names: Set<string>,
  callEdges: Set<string>
): void {
  const visited = new Set<string>();
  const queue: Array<{ name: string; depth: number }> = [{ name: functionName, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.name) || current.depth > depthLimit) {
      continue;
    }
    visited.add(current.name);
    names.add(current.name);
    if (current.depth >= depthLimit) {
      continue;
    }
    for (const caller of index.calledBy[current.name] ?? []) {
      names.add(caller);
      callEdges.add(functionCallEdgeKey(caller, current.name));
      queue.push({ name: caller, depth: current.depth + 1 });
    }
  }
}
