import * as fs from "node:fs/promises";
import type {
  FileAnalysis,
  FileSignature,
  GlobalVariable,
  MacroAlias,
  MacroDefinition,
  MemberSymbol,
  StructTypeInfo
} from "./types";

interface GlobalTypeInfo {
  global: GlobalVariable;
  type: StructTypeInfo;
}

export interface MemberAnalysisContext {
  structTypes: Map<string, StructTypeInfo>;
  globalTypes: Map<string, GlobalTypeInfo>;
  memberSymbols: Map<string, MemberSymbol[]>;
  knownTypeNames: Set<string>;
  knownMemberNames: Set<string>;
}

export interface MacroAnalysisContext {
  definitions: Map<string, MacroDefinition[]>;
  aliases: Map<string, MacroAlias[]>;
}

export async function getFileSignature(file: string): Promise<FileSignature> {
  const stat = await fs.stat(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

export function buildMemberAnalysisContext(
  files: Array<Pick<FileAnalysis, "globals" | "structTypes">>
): MemberAnalysisContext {
  const structTypes = new Map<string, StructTypeInfo>();
  const knownMemberNames = new Set<string>();
  for (const file of files) {
    for (const structType of file.structTypes ?? []) {
      for (const typeName of [structType.name, ...structType.aliases]) {
        if (typeName && !structTypes.has(typeName)) {
          structTypes.set(typeName, structType);
        }
      }
      for (const member of structType.members) {
        knownMemberNames.add(member.name);
      }
    }
  }

  const globalTypes = new Map<string, GlobalTypeInfo>();
  for (const file of files) {
    for (const global of file.globals) {
      const typeName = global.typeName;
      const type = typeName ? structTypes.get(typeName) : undefined;
      if (typeName && type) {
        globalTypes.set(global.name, { global, type });
      }
    }
  }

  const memberSymbols = new Map<string, MemberSymbol[]>();
  for (const { global, type } of globalTypes.values()) {
    for (const symbol of buildMemberSymbolsForGlobal(global, type, structTypes)) {
      memberSymbols.set(symbol.name, [...(memberSymbols.get(symbol.name) ?? []), symbol]);
    }
  }

  return {
    structTypes,
    globalTypes,
    memberSymbols,
    knownTypeNames: new Set(structTypes.keys()),
    knownMemberNames
  };
}

export function buildMacroAnalysisContext(
  files: Array<Pick<FileAnalysis, "macroDefinitions">>,
  globalNames: Set<string>,
  memberContext: MemberAnalysisContext
): MacroAnalysisContext {
  const definitions = new Map<string, MacroDefinition[]>();
  for (const file of files) {
    for (const definition of file.macroDefinitions ?? []) {
      definitions.set(definition.name, [...(definitions.get(definition.name) ?? []), definition]);
    }
  }

  const aliases = new Map<string, MacroAlias[]>();
  for (const macroDefinitions of definitions.values()) {
    for (const definition of macroDefinitions) {
      const alias = resolveMacroAlias(definition, globalNames, memberContext);
      if (alias) {
        aliases.set(alias.name, [...(aliases.get(alias.name) ?? []), alias]);
      }
    }
  }
  return { definitions, aliases };
}

function resolveMacroAlias(
  definition: MacroDefinition,
  globalNames: Set<string>,
  memberContext: MemberAnalysisContext
): MacroAlias | undefined {
  if (definition.isFunctionLike || !definition.replacement || isHeaderGuardMacro(definition)) {
    return undefined;
  }
  const replacement = definition.replacement.trim();
  if (!isSimpleMacroReplacement(replacement)) {
    return undefined;
  }
  const targetKind = globalNames.has(replacement)
    ? "global"
    : memberContext.memberSymbols.has(replacement)
      ? "member"
      : "unknown";
  if (targetKind === "unknown" && /\d/.test(replacement[0] ?? "")) {
    return undefined;
  }
  return {
    name: definition.name,
    replacement,
    targetName: replacement,
    targetKind,
    file: definition.file,
    line: definition.line,
    declaration: definition.declaration
  };
}

function isHeaderGuardMacro(definition: MacroDefinition): boolean {
  return definition.replacement.length === 0 && /(?:_H|_H_|_INCLUDED|_INCLUDED_)$/i.test(definition.name);
}

function isSimpleMacroReplacement(value: string): boolean {
  return /^[A-Za-z_]\w*(?:(?:\.|->|::)[A-Za-z_]\w*)*$/.test(value);
}

function buildMemberSymbolsForGlobal(
  global: GlobalVariable,
  type: StructTypeInfo,
  structTypes: Map<string, StructTypeInfo>
): MemberSymbol[] {
  const ownerName = global.isArray ? `${global.name}[]` : global.name;
  const firstSeparator = (global.pointerLevel ?? 0) > 0 ? "->" : ".";
  const symbols: MemberSymbol[] = [];
  appendMemberSymbols({
    symbols,
    ownerName,
    ownerTypeName: type.name,
    file: global.file,
    line: global.line,
    declarationPrefix: global.declaration,
    pathPrefix: "",
    separator: firstSeparator,
    type,
    structTypes,
    isArrayOwner: global.isArray,
    pointerOwner: (global.pointerLevel ?? 0) > 0,
    depth: 0
  });
  return symbols;
}

function appendMemberSymbols(args: {
  symbols: MemberSymbol[];
  ownerName: string;
  ownerTypeName: string;
  file: string;
  line: number;
  declarationPrefix: string;
  pathPrefix: string;
  separator: "." | "->";
  type: StructTypeInfo;
  structTypes: Map<string, StructTypeInfo>;
  isArrayOwner?: boolean;
  pointerOwner?: boolean;
  depth: number;
}): void {
  if (args.depth > 2) {
    return;
  }
  for (const member of args.type.members) {
    const memberPath = args.pathPrefix ? `${args.pathPrefix}.${member.name}` : member.name;
    const name = `${args.ownerName}${args.separator}${memberPath}`;
    args.symbols.push({
      name,
      ownerName: args.ownerName,
      ownerTypeName: args.ownerTypeName,
      memberName: member.name,
      memberPath: memberPath.split("."),
      file: args.file,
      line: args.line,
      declaration: `${args.declarationPrefix} :: ${member.declaration}`,
      isArrayOwner: args.isArrayOwner,
      pointerOwner: args.pointerOwner
    });
    const nestedType = member.typeName ? args.structTypes.get(member.typeName) : undefined;
    if (nestedType && (member.pointerLevel ?? 0) === 0) {
      appendMemberSymbols({
        ...args,
        pathPrefix: memberPath,
        separator: args.separator,
        type: nestedType,
        depth: args.depth + 1
      });
    }
  }
}
