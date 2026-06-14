import type {
  AnalysisIndex,
  FunctionInfo,
  GraphEdge,
  GraphNode,
  GlobalVariable,
  ImpactResult,
  MacroAlias,
  MemberSymbol,
  RiskCandidate,
  SourceLocation,
  ThreadReachability,
  UnresolvedEvidence,
  VariableAccess
} from "./types";
import { collectDirectionalFunctionNeighborhood, functionCallEdgeKey, isFunctionTopologyUnresolved, type FunctionNeighborhood } from "./functionImpactPolicy";

export function buildImpact(index: AnalysisIndex, symbolName: string, maxDepth = 4): ImpactResult {
  const inferred = inferMemberSelection(index, symbolName);
  const lookupSymbols = new Set([symbolName, ...inferred.typeMemberNames, ...inferred.actualMemberNames]);
  const globals = index.globals[symbolName] ?? [];
  const members = uniqueMembers([
    ...(index.memberSymbols?.[symbolName] ?? []),
    ...inferred.actualMemberNames.flatMap((name) => index.memberSymbols?.[name] ?? [])
  ]);
  const macros = index.macroAliases?.[symbolName] ?? [];
  const selectedFunction = index.functions[symbolName];
  const symbolKind = globals.length > 0
    ? "global"
    : members.length > 0
      ? "member"
      : macros.length > 0
        ? "macro"
        : selectedFunction
          ? "function"
          : "unknown";
  const macroTargets = new Set(macros.map((macro) => macro.targetName));
  const functionNeighborhood = symbolKind === "function" && selectedFunction
    ? collectDirectionalFunctionNeighborhood(index, selectedFunction.name, maxDepth)
    : undefined;
  const rawFunctions = symbolKind === "function" && selectedFunction
    ? functionsFromNeighborhood(index, functionNeighborhood!)
    : symbolKind === "macro"
      ? functionsTouchingMacro(index, symbolName, macroTargets)
      : functionsTouchingSymbols(index, lookupSymbols);
  const functions = symbolKind === "function"
    ? rawFunctions.map((func) => ({ ...func, accesses: [] }))
    : rawFunctions;
  const accesses = symbolKind === "function"
    ? []
    : symbolKind === "global" || symbolKind === "member" || symbolKind === "unknown"
      ? functions.flatMap((func) => func.accesses.filter((access) => accessMatchesAny(access, lookupSymbols)))
      : functions.flatMap((func) => func.accesses.filter((access) =>
        access.macroNames?.includes(symbolName) ||
        macroTargets.has(access.targetName ?? access.variableName) ||
        macroTargets.has(access.variableName)
      ));
  const threadContexts = uniqueThreadContexts(
    functions
      .map((func) => index.threadReachability[func.name])
      .filter((item): item is ThreadReachability => Boolean(item))
  );
  const unresolved = uniqueUnresolved(
    [
      ...functions.flatMap((func) => func.unresolved),
      ...index.files.flatMap((file) => file.unresolved)
    ].filter((item) => unresolvedRelevant(item, symbolKind, symbolName, functions, macroTargets, lookupSymbols))
  );
  const risks = buildRisks(symbolName, symbolKind, accesses, threadContexts, unresolved);
  const graph = buildGraph(symbolName, symbolKind, globals, members, macros, functions, accesses, threadContexts, risks, unresolved, functionNeighborhood?.callEdges);

  return {
    symbolName,
    symbolKind,
    globals,
    members,
    macros,
    functions,
    accesses,
    threadContexts,
    risks,
    unresolved,
    graph
  };
}

function functionsTouchingSymbols(index: AnalysisIndex, variableNames: Set<string>): FunctionInfo[] {
  return Object.values(index.functions)
    .filter((func) => func.accesses.some((access) => accessMatchesAny(access, variableNames)))
    .sort(byFunctionName);
}

function functionsTouchingMacro(index: AnalysisIndex, macroName: string, targetNames: Set<string>): FunctionInfo[] {
  return Object.values(index.functions)
    .filter((func) => func.accesses.some((access) =>
      access.macroNames?.includes(macroName) ||
      targetNames.has(access.targetName ?? access.variableName) ||
      targetNames.has(access.variableName)
    ))
    .sort(byFunctionName);
}

function functionsFromNeighborhood(index: AnalysisIndex, neighborhood: FunctionNeighborhood): FunctionInfo[] {
  return [...neighborhood.names]
    .map((name) => index.functions[name])
    .filter((func): func is FunctionInfo => Boolean(func))
    .sort(byFunctionName);
}

function buildRisks(
  symbolName: string,
  symbolKind: ImpactResult["symbolKind"],
  accesses: VariableAccess[],
  threadContexts: ThreadReachability[],
  unresolved: UnresolvedEvidence[]
): RiskCandidate[] {
  const risks: RiskCandidate[] = [];
  const writes = accesses.filter((access) => access.kind === "write");
  const reads = accesses.filter((access) => access.kind === "read");
  const unknowns = accesses.filter((access) => access.kind === "unknown");
  const writerThreads = new Set(writes.flatMap((access) => threadIdsForFunction(access.functionName, threadContexts)));
  const readerThreads = new Set(reads.flatMap((access) => threadIdsForFunction(access.functionName, threadContexts)));
  const interruptThreads = threadContexts.flatMap((context) => context.interruptLikeThreadIds);

  if (isDataSymbol(symbolKind) && writerThreads.size >= 2) {
    risks.push({
      code: "MULTI_THREAD_WRITE",
      severity: "high",
      title: "複数スレッドからの書き込み候補",
      detail: `${symbolName} は ${[...writerThreads].join(", ")} から書き込まれる候補があります。`,
      evidence: writes.map((access) => access.location)
    });
  }
  if (isDataSymbol(symbolKind) && writerThreads.size > 0 && readerThreads.size > 0 && unionSize(writerThreads, readerThreads) >= 2) {
    risks.push({
      code: "CROSS_THREAD_READ_WRITE",
      severity: "warning",
      title: "スレッド間read/write干渉候補",
      detail: `${symbolName} は複数スレッド文脈でread/writeされる候補があります。`,
      evidence: [...writes, ...reads].map((access) => access.location)
    });
  }
  if (interruptThreads.length > 0 && accesses.length > 0) {
    risks.push({
      code: "INTERRUPT_CONTEXT",
      severity: "high",
      title: "割込み系スレッド文脈の関与",
      detail: `割込み制約ありの文脈 (${[...new Set(interruptThreads)].join(", ")}) が関与します。`,
      evidence: accesses.map((access) => access.location)
    });
  }
  if (unknowns.length > 0 || unresolved.length > 0) {
    risks.push({
      code: "UNRESOLVED_ACCESS",
      severity: "warning",
      title: "未解決アクセスあり",
      detail: "マクロ、inline asm、関数ポインタ、ポインタ経由更新など断定できない箇所があります。",
      evidence: [...unknowns.map((access) => access.location), ...unresolved.map((item) => item.location)]
    });
  }
  const addressTaken = unresolved.filter((item) => item.kind === "address-taken");
  if (addressTaken.length > 0) {
    risks.push({
      code: "POINTER_ALIAS",
      severity: "warning",
      title: "ポインタ別名による更新候補",
      detail: "グローバル変数のアドレス取得があるため、以降の別名経由更新を追加確認してください。",
      evidence: addressTaken.map((item) => item.location)
    });
  }
  const functionPointers = unresolved.filter((item) => item.kind === "function-pointer");
  if (functionPointers.length > 0) {
    risks.push({
      code: "FUNCTION_POINTER",
      severity: "info",
      title: "関数ポインタ経由呼び出し",
      detail: "呼び出し先を静的に断定していない関数ポインタ呼び出しがあります。",
      evidence: functionPointers.map((item) => item.location)
    });
  }
  return risks;
}

function buildGraph(
  symbolName: string,
  symbolKind: ImpactResult["symbolKind"],
  globals: GlobalVariable[],
  members: MemberSymbol[],
  macros: MacroAlias[],
  functions: FunctionInfo[],
  accesses: VariableAccess[],
  threadContexts: ThreadReachability[],
  risks: RiskCandidate[],
  unresolved: UnresolvedEvidence[],
  allowedFunctionCallEdges?: Set<string>
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  addNode(nodes, { id: `target:${symbolName}`, label: symbolName, kind: "target" });

  if (symbolKind === "global") {
    for (const global of globals) {
      const id = `global:${global.name}:${global.file}:${global.line}`;
      addNode(nodes, { id, label: `${global.name}:${global.line}`, kind: "global" });
      edges.push({ from: `target:${symbolName}`, to: id, label: "decl" });
    }
  }
  if (symbolKind === "member") {
    for (const member of members) {
      const id = `member:${member.name}:${member.file}:${member.line}`;
      addNode(nodes, { id, label: `${member.name}:${member.line}`, kind: "member" });
      edges.push({ from: `target:${symbolName}`, to: id, label: "decl" });
    }
  }
  if (symbolKind === "macro") {
    for (const macro of macros) {
      const id = `macro:${macro.name}:${macro.file}:${macro.line}`;
      addNode(nodes, { id, label: `${macro.name}:${macro.line}`, kind: "macro" });
      edges.push({ from: `target:${symbolName}`, to: id, label: "decl" });
      if (macro.targetName) {
        const targetId = `macro-target:${macro.targetName}`;
        addNode(nodes, { id: targetId, label: macro.targetName, kind: macro.targetKind === "member" ? "member" : "global" });
        edges.push({ from: id, to: targetId, label: "expands-to" });
      }
    }
  }

  for (const func of functions) {
    const functionId = `function:${func.name}`;
    addNode(nodes, { id: functionId, label: func.name, kind: "function" });
    edges.push({ from: `target:${symbolName}`, to: functionId, label: symbolKind === "function" ? "related" : "access" });
  }
  if (symbolKind === "function") {
    const functionNames = new Set(functions.map((func) => func.name));
    const seenCallEdges = new Set<string>();
    for (const func of functions) {
      for (const called of func.calls) {
        if (!functionNames.has(called)) {
          continue;
        }
        const edgeKey = functionCallEdgeKey(func.name, called);
        if (allowedFunctionCallEdges && !allowedFunctionCallEdges.has(edgeKey)) {
          continue;
        }
        if (seenCallEdges.has(edgeKey)) {
          continue;
        }
        seenCallEdges.add(edgeKey);
        edges.push({ from: `function:${func.name}`, to: `function:${called}`, label: "calls" });
      }
    }
  }
  for (const access of accesses) {
    edges.push({
      from: `function:${access.functionName}`,
      to: `target:${symbolName}`,
      label: access.kind
    });
  }
  for (const context of threadContexts) {
    for (const threadId of context.threadIds) {
      const threadNode = `thread:${threadId}`;
      addNode(nodes, { id: threadNode, label: threadId, kind: "thread" });
      edges.push({ from: threadNode, to: `function:${context.functionName}`, label: "reaches" });
    }
  }
  for (const risk of risks) {
    const riskNode = `risk:${risk.code}`;
    addNode(nodes, { id: riskNode, label: risk.title, kind: "risk" });
    edges.push({ from: `target:${symbolName}`, to: riskNode, label: risk.severity });
  }
  if (unresolved.length > 0) {
    addNode(nodes, { id: "unresolved", label: `未解決 ${unresolved.length}`, kind: "unresolved" });
    edges.push({ from: `target:${symbolName}`, to: "unresolved", label: "needs-review" });
  }
  return { nodes: [...nodes.values()], edges };
}

function unresolvedRelevant(
  item: UnresolvedEvidence,
  symbolKind: ImpactResult["symbolKind"],
  symbolName: string,
  functions: FunctionInfo[],
  macroTargets: Set<string>,
  lookupSymbols: Set<string>
): boolean {
  if (symbolKind === "function") {
    return isFunctionTopologyUnresolved(item.kind) && functions.some((func) => func.name === item.functionName);
  }
  if (item.variableName && lookupSymbols.has(item.variableName)) {
    return true;
  }
  if (symbolKind === "global" || symbolKind === "member") {
    return item.variableName === directParentSymbolName(symbolName);
  }
  if (symbolKind === "macro") {
    return macroTargets.has(item.variableName ?? "");
  }
  return false;
}

function inferMemberSelection(index: AnalysisIndex, symbolName: string): { typeMemberNames: string[]; actualMemberNames: string[] } {
  const typeMemberNames = new Set<string>();
  const actualMemberNames = new Set<string>();
  if (symbolName.includes("::")) {
    typeMemberNames.add(symbolName);
  } else if (!isDirectDataSymbol(index, symbolName)) {
    const normalizedSelection = normalizeMemberLookupText(symbolName);
    const memberPath = memberPathFromLookup(normalizedSelection);
    if (memberPath) {
      for (const func of Object.values(index.functions)) {
        for (const access of func.accesses) {
          if (
            access.variableName.includes("::") &&
            memberPathFromLookup(access.variableName) === memberPath &&
            normalizeMemberLookupText(access.accessExpression ?? access.evidence).includes(normalizedSelection)
          ) {
            typeMemberNames.add(access.variableName);
          }
        }
        for (const item of func.unresolved) {
          if (
            item.kind === "unknown-member-access" &&
            item.variableName?.includes("::") &&
            memberPathFromLookup(item.variableName) === memberPath &&
            normalizeMemberLookupText(item.evidence).includes(normalizedSelection)
          ) {
            typeMemberNames.add(item.variableName);
          }
        }
      }
    }
  }

  if (typeMemberNames.size > 0) {
    for (const func of Object.values(index.functions)) {
      for (const access of func.accesses) {
        if (access.targetName && typeMemberNames.has(access.targetName) && index.memberSymbols?.[access.variableName]) {
          actualMemberNames.add(access.variableName);
        }
      }
    }
  }
  return {
    typeMemberNames: [...typeMemberNames].sort(),
    actualMemberNames: [...actualMemberNames].sort()
  };
}

function isDirectDataSymbol(index: AnalysisIndex, symbolName: string): boolean {
  return Boolean(index.globals[symbolName]?.length || index.memberSymbols?.[symbolName]?.length || index.macroAliases?.[symbolName]?.length);
}

function accessMatchesAny(access: VariableAccess, symbols: Set<string>): boolean {
  return symbols.has(access.variableName) || Boolean(access.targetName && symbols.has(access.targetName));
}

function memberPathFromLookup(symbolName: string): string | undefined {
  const normalized = normalizeMemberLookupText(symbolName);
  const typeIndex = normalized.indexOf("::");
  if (typeIndex >= 0) {
    return normalized.slice(typeIndex + 2);
  }
  const arrowIndex = normalized.indexOf("->");
  const dotIndex = normalized.indexOf(".");
  const separatorIndex = arrowIndex >= 0 && dotIndex >= 0
    ? Math.min(arrowIndex, dotIndex)
    : Math.max(arrowIndex, dotIndex);
  if (separatorIndex < 0) {
    return undefined;
  }
  return normalized.slice(separatorIndex + (normalized.startsWith("->", separatorIndex) ? 2 : 1));
}

function normalizeMemberLookupText(value: string): string {
  return value.replace(/\s+/g, "").replace(/\[[^\]]+\]/g, "[]");
}

function uniqueMembers(members: MemberSymbol[]): MemberSymbol[] {
  const seen = new Set<string>();
  return members.filter((member) => {
    const key = `${member.name}:${member.file}:${member.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function directParentSymbolName(symbolName: string): string | undefined {
  const dotIndex = symbolName.lastIndexOf(".");
  const arrowIndex = symbolName.lastIndexOf("->");
  const separatorIndex = Math.max(dotIndex, arrowIndex);
  if (separatorIndex <= 0) {
    return undefined;
  }
  return symbolName.slice(0, separatorIndex);
}

function uniqueThreadContexts(items: ThreadReachability[]): ThreadReachability[] {
  const byName = new Map<string, ThreadReachability>();
  for (const item of items) {
    byName.set(item.functionName, item);
  }
  return [...byName.values()].sort((left, right) => left.functionName.localeCompare(right.functionName));
}

function uniqueUnresolved(items: UnresolvedEvidence[]): UnresolvedEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.functionName}:${item.variableName}:${item.location.file}:${item.location.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function threadIdsForFunction(functionName: string, contexts: ThreadReachability[]): string[] {
  return contexts.find((context) => context.functionName === functionName)?.threadIds ?? ["未分類"];
}

function unionSize<T>(left: Set<T>, right: Set<T>): number {
  return new Set([...left, ...right]).size;
}

function isDataSymbol(symbolKind: ImpactResult["symbolKind"]): boolean {
  return symbolKind === "global" || symbolKind === "member" || symbolKind === "macro";
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function byFunctionName(left: FunctionInfo, right: FunctionInfo): number {
  return left.name.localeCompare(right.name);
}
