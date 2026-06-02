export type AccessKind = "read" | "write" | "unknown";

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  text?: string;
}

export interface FileSignature {
  size: number;
  mtimeMs: number;
}

export interface Vc6ProjectInfo {
  projectFile: string;
  workspaceRoot: string;
  sourceFiles: string[];
  includePaths: string[];
  macros: string[];
}

export interface ThreadDefinition {
  threadId: string;
  entryFunction: string;
  priority?: string;
  cycle?: string;
  isInterruptLike?: boolean;
  notes?: string;
}

export interface ThreadMap {
  threads: ThreadDefinition[];
}

export interface GlobalVariable {
  name: string;
  file: string;
  line: number;
  declaration: string;
  isExtern: boolean;
  typeName?: string;
  isArray?: boolean;
  pointerLevel?: number;
}

export interface StructMemberInfo {
  name: string;
  typeName?: string;
  file: string;
  line: number;
  declaration: string;
  isArray?: boolean;
  pointerLevel?: number;
}

export interface StructTypeInfo {
  name: string;
  aliases: string[];
  file: string;
  line: number;
  declaration: string;
  members: StructMemberInfo[];
}

export interface MemberSymbol {
  name: string;
  ownerName: string;
  ownerTypeName: string;
  memberName: string;
  memberPath: string[];
  file: string;
  line: number;
  declaration: string;
  isArrayOwner?: boolean;
  pointerOwner?: boolean;
}

export interface MacroDefinition {
  name: string;
  replacement: string;
  file: string;
  line: number;
  declaration: string;
  isFunctionLike: boolean;
  isObjectLike: boolean;
}

export interface MacroAlias {
  name: string;
  replacement: string;
  targetName: string;
  targetKind: "global" | "member" | "unknown";
  file: string;
  line: number;
  declaration: string;
}

export type ParserEngine = "rust" | "typescript" | "clang";

export interface ParserDiagnostic {
  backend: ParserEngine;
  file?: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface VariableAccess {
  variableName: string;
  targetName?: string;
  targetKind?: "global" | "member";
  functionName: string;
  kind: AccessKind;
  location: SourceLocation;
  evidence: string;
  reasons: string[];
  ownerName?: string;
  memberName?: string;
  accessExpression?: string;
  macroNames?: string[];
  expandedEvidence?: string;
}

export interface UnresolvedEvidence {
  kind:
    | "inline-asm"
    | "function-pointer"
    | "macro"
    | "address-taken"
    | "pointer-write"
    | "unknown-call"
    | "unknown-member-access"
    | "ambiguous-member-alias"
    | "unsupported-member-declaration";
  functionName?: string;
  variableName?: string;
  location: SourceLocation;
  evidence: string;
  note: string;
}

export interface FunctionInfo {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  calls: string[];
  accesses: VariableAccess[];
  unresolved: UnresolvedEvidence[];
}

export interface FileAnalysis {
  file: string;
  signature: FileSignature;
  globals: GlobalVariable[];
  structTypes: StructTypeInfo[];
  macroDefinitions: MacroDefinition[];
  functions: FunctionInfo[];
  unresolved: UnresolvedEvidence[];
}

export interface SkippedSourceFile {
  file: string;
  phase?: "summary" | "access" | "unknown";
  reason: string;
  sourceBytes?: number;
  rssBeforeBytes?: number;
  rssAfterBytes?: number;
  rssDeltaBytes?: number;
  requestedBytes?: number;
  diagnosticLogPath?: string;
  diagnosticSummaryPath?: string;
  skippedAt: string;
}

export interface ThreadReachability {
  functionName: string;
  threadIds: string[];
  interruptLikeThreadIds: string[];
}

export interface AnalysisIndex {
  version: 1;
  generatedAt: string;
  workspaceRoot: string;
  projectFile: string;
  projectFiles: string[];
  includePaths: string[];
  macros: string[];
  files: FileAnalysis[];
  fileSignatures?: Record<string, FileSignature>;
  fileUnresolved?: UnresolvedEvidence[];
  globals: Record<string, GlobalVariable[]>;
  structTypes: Record<string, StructTypeInfo>;
  memberSymbols: Record<string, MemberSymbol[]>;
  macroDefinitions: Record<string, MacroDefinition[]>;
  macroAliases: Record<string, MacroAlias[]>;
  parserDiagnostics: ParserDiagnostic[];
  functions: Record<string, FunctionInfo>;
  accessIndex?: Record<string, string[]>;
  callGraph: Record<string, string[]>;
  calledBy: Record<string, string[]>;
  threads: ThreadDefinition[];
  threadReachability: Record<string, ThreadReachability>;
  build: {
    mode: "full" | "update";
    parserMode: ParserEngine;
    durationMs: number;
    phaseDurationsMs: Record<string, number>;
    workerCount: number;
    changedFiles: string[];
    reusedFiles: number;
    fullRebuildReason?: string;
    sourceFileCount: number;
    analyzedFileCount?: number;
    skippedFiles?: SkippedSourceFile[];
  };
  storage?: {
    layout: "split-v1";
    functionsPath: string;
  };
}

export type RiskSeverity = "info" | "warning" | "high";

export interface RiskCandidate {
  code:
    | "MULTI_THREAD_WRITE"
    | "CROSS_THREAD_READ_WRITE"
    | "INTERRUPT_CONTEXT"
    | "UNRESOLVED_ACCESS"
    | "POINTER_ALIAS"
    | "FUNCTION_POINTER";
  severity: RiskSeverity;
  title: string;
  detail: string;
  evidence: SourceLocation[];
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "target" | "global" | "member" | "macro" | "function" | "thread" | "risk" | "unresolved";
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface ImpactResult {
  symbolName: string;
  symbolKind: "global" | "member" | "macro" | "function" | "unknown";
  globals: GlobalVariable[];
  members: MemberSymbol[];
  macros: MacroAlias[];
  functions: FunctionInfo[];
  accesses: VariableAccess[];
  threadContexts: ThreadReachability[];
  risks: RiskCandidate[];
  unresolved: UnresolvedEvidence[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
}

export interface BuildOptions {
  workspaceRoot: string;
  projectFile: string;
  projectConfiguration?: string;
  threadMapFile?: string;
  excludeGlobs?: string[];
  maxIndexWorkers?: number;
  maxNativeBatchFiles?: number;
  rustSidecarTimeoutMs?: number;
  parserEngine?: ParserEngine;
  projectEncoding?: "auto" | "utf8" | "cp932";
  sourceEncoding?: "auto" | "utf8" | "cp932";
  outputDir?: string;
  maxRustAutoSkippedFiles?: number;
}

export interface BuildResult {
  index: AnalysisIndex;
  indexPath?: string;
}
