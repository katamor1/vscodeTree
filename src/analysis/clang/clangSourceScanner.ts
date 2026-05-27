import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { analyzeFilesWithTypeScript, type TypeScriptAnalysisResult } from "../typescript/typescriptSourceScanner";
import type { TextEncoding } from "../textEncoding";
import type { ParserDiagnostic } from "../types";

const execFileAsync = promisify(execFile);

export async function analyzeFilesWithClang(
  files: string[],
  sourceEncoding: TextEncoding = "auto",
  includePaths: string[] = [],
  macros: string[] = []
): Promise<TypeScriptAnalysisResult> {
  const diagnostics: ParserDiagnostic[] = [];
  const clang = await findClangExecutable();
  if (!clang) {
    diagnostics.push({
      backend: "clang",
      severity: "warning",
      message: "clang executable was not found; using TypeScript extraction without clang diagnostics."
    });
    return analyzeFilesWithTypeScript(files, sourceEncoding, "clang", diagnostics);
  }

  diagnostics.push({
    backend: "clang",
    severity: "info",
    message: `clang executable detected: ${clang}`
  });
  for (const file of files.filter((item) => /\.(?:c|cc|cpp|cxx|h|hpp)$/i.test(item)).slice(0, 200)) {
    const diagnostic = await runClangSyntaxOnly(clang, file, includePaths, macros);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }
  if (files.length > 200) {
    diagnostics.push({
      backend: "clang",
      severity: "info",
      message: `clang diagnostics limited to first 200 files of ${files.length}; TypeScript extraction still processed all files.`
    });
  }
  return analyzeFilesWithTypeScript(files, sourceEncoding, "clang", diagnostics);
}

async function runClangSyntaxOnly(
  clang: string,
  file: string,
  includePaths: string[],
  macros: string[]
): Promise<ParserDiagnostic | undefined> {
  const args = [
    "-fsyntax-only",
    "-x",
    "c++",
    "-std=c++98",
    "-I",
    path.dirname(file),
    ...includePaths.flatMap((includePath) => ["-I", includePath]),
    ...macros.map((macro) => `-D${macro}`),
    file
  ];
  try {
    await execFileAsync(clang, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024
    });
    return undefined;
  } catch (error) {
    return {
      backend: "clang",
      file,
      severity: "warning",
      message: `clang syntax diagnostics unavailable or failed for ${path.basename(file)}: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    };
  }
}

async function findClangExecutable(): Promise<string | undefined> {
  const explicit = process.env.VC6_IMPACT_CLANG?.trim();
  if (explicit && await exists(explicit)) {
    return explicit;
  }
  for (const candidate of clangCandidates()) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function clangCandidates(): string[] {
  return [
    "clang.exe",
    "clang-cl.exe",
    "C:/Program Files/LLVM/bin/clang.exe",
    "C:/Program Files/LLVM/bin/clang-cl.exe",
    "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/Llvm/bin/clang.exe",
    "C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/Llvm/bin/clang-cl.exe",
    "C:/Program Files/Microsoft Visual Studio/17/Community/VC/Tools/Llvm/bin/clang.exe",
    "C:/Program Files/Microsoft Visual Studio/17/Community/VC/Tools/Llvm/bin/clang-cl.exe"
  ];
}

async function exists(file: string): Promise<boolean> {
  if (!file.includes("/") && !file.includes("\\")) {
    try {
      await execFileAsync("where.exe", [file], { windowsHide: true, timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0] ?? value;
}
