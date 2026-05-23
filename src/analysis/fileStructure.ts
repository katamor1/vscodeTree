import type {
  FileSignature,
  GlobalVariable,
  StructTypeInfo,
  UnresolvedEvidence
} from "./types";

export interface BodyLine {
  line: number;
  raw: string;
  masked: string;
  identifiers: string[];
  callIdentifiers: string[];
}

export interface FunctionStructure {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  bodyLines: BodyLine[];
}

export interface FileStructure {
  file: string;
  signature: FileSignature;
  globals: GlobalVariable[];
  structTypes: StructTypeInfo[];
  functions: FunctionStructure[];
  unresolved: UnresolvedEvidence[];
}
