const fs = require("node:fs/promises");
const path = require("node:path");

const root = process.env.VC6_IMPACT_LARGE_SAMPLE || "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample";
const srcDir = path.join(root, "src");
const linesPerFile = Number(process.env.VC6_IMPACT_STRESS_LINES || 60);
const probeCallsPerLine = Number(process.env.VC6_IMPACT_STRESS_PROBES || 120);
const nestDepth = Number(process.env.VC6_IMPACT_STRESS_NEST || 12);
const globalAccessStride = Number(process.env.VC6_IMPACT_STRESS_GLOBAL_STRIDE || 20);
const markerStart = "// BEGIN GENERATED RELATION STRESS";
const markerEnd = "// END GENERATED RELATION STRESS";

async function main() {
  const modFiles = (await fs.readdir(srcDir))
    .filter((name) => /^mod_\d{3}_\d{2}\.cpp$/i.test(name))
    .sort();
  if (modFiles.length === 0) {
    throw new Error(`No generated mod_*.cpp files found under ${srcDir}`);
  }

  const stressFunctions = modFiles.map((name, index) => ({
    fileName: name,
    index,
    module: Number(name.slice(4, 7)),
    part: Number(name.slice(8, 10)),
    name: `StressRel_${name.replace(/\.cpp$/i, "").replace(/[^A-Za-z0-9_]/g, "_")}`
  }));

  await writeIfChanged(path.join(srcDir, "stress_relations.h"), renderHeader(stressFunctions));
  await writeIfChanged(path.join(srcDir, "stress_relations.cpp"), renderEntries(stressFunctions));
  await ensureGlobalsInclude(path.join(srcDir, "globals.h"));
  await ensureDspSources(root);
  await ensureThreadCalls(path.join(srcDir, "main.cpp"));

  for (const fn of stressFunctions) {
    const file = path.join(srcDir, fn.fileName);
    const current = await fs.readFile(file, "utf8");
    const block = renderStressBlock(fn, stressFunctions);
    await fs.writeFile(file, replaceGeneratedBlock(current, block), "utf8");
  }

  const manifestPath = path.join(root, "stress-manifest.json");
  const existing = await readJsonIfExists(path.join(root, "manifest.json"));
  const sourceBytes = await totalSourceBytes(srcDir);
  const oldEstimate = estimateLegacyMemoryBytes(stressFunctions.length, linesPerFile, probeCallsPerLine);
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      root,
      stressFunctionCount: stressFunctions.length,
      linesPerFile,
      probeCallsPerLine,
      nestDepth,
      globalAccessStride,
      addedFiles: ["src/stress_relations.h", "src/stress_relations.cpp"],
      sourceBytes,
      sourceMb: round(sourceBytes / 1024 / 1024, 1),
      estimatedLegacyStructureMemoryBytes: oldEstimate,
      estimatedLegacyStructureMemoryGb: round(oldEstimate / 1024 / 1024 / 1024, 1),
      estimateBasis: "Approximation for old in-memory FileStructure body lines: raw/masked line strings plus identifier/call identifier String allocations kept for all files.",
      originalManifest: existing
    }, null, 2)}\n`,
    "utf8"
  );

  console.log(JSON.stringify({
    root,
    stressFunctionCount: stressFunctions.length,
    linesPerFile,
    probeCallsPerLine,
    nestDepth,
    globalAccessStride,
    sourceMb: round(sourceBytes / 1024 / 1024, 1),
    estimatedLegacyStructureMemoryGb: round(oldEstimate / 1024 / 1024 / 1024, 1),
    manifest: manifestPath.replace(/\\/g, "/")
  }, null, 2));
}

function renderHeader(functions) {
  return [
    "#ifndef GENERATED_STRESS_RELATIONS_H",
    "#define GENERATED_STRESS_RELATIONS_H",
    "",
    "void StressEntry_00(int step);",
    "void StressEntry_01(int step);",
    "void StressEntry_02(int step);",
    "void StressEntry_03(int step);",
    "void StressEntry_04(int step);",
    "void StressEntry_05(int step);",
    "void StressEntry_06(int step);",
    "void StressEntry_07(int step);",
    "void StressEntry_08(int step);",
    "void StressEntry_09(int step);",
    "void StressEntry_10(int step);",
    "void StressEntry_11(int step);",
    "void StressEntry_12(int step);",
    "void StressEntry_13(int step);",
    "void StressEntry_14(int step);",
    "void StressEntry_15(int step);",
    "",
    ...functions.map((fn) => `void ${fn.name}(int seed);`),
    "",
    "#endif",
    ""
  ].join("\n");
}

function renderEntries(functions) {
  const lines = ['#include "globals.h"', ""];
  for (let index = 0; index < 16; index += 1) {
    const target = functions[Math.floor((functions.length / 16) * index)];
    lines.push(`void StressEntry_${pad(index, 2)}(int step)`);
    lines.push("{");
    lines.push(`    ${target.name}(step);`);
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

function renderStressBlock(fn, functions) {
  const nextA = functions[(fn.index + 1) % functions.length];
  const nextB = functions[(fn.index + 97) % functions.length];
  const nextC = functions[(fn.index + 521) % functions.length];
  const lines = [markerStart, `void ${fn.name}(int seed)`, "{"];
  lines.push("    int local_00 = seed;");
  lines.push("    int local_01 = seed + 1;");
  lines.push("    int local_02 = seed + 2;");
  lines.push("    int local_03 = seed + 3;");
  for (let depth = 0; depth < nestDepth; depth += 1) {
    lines.push(`${"    ".repeat(depth + 1)}if (((seed + ${depth}) & ${depth + 1}) >= 0) {`);
  }
  const indent = "    ".repeat(nestDepth + 1);
  for (let line = 0; line < linesPerFile; line += 1) {
    const moduleA = pad((fn.module + line) % 280, 3);
    const moduleB = pad((fn.module + line + 13) % 280, 3);
    const valueA = pad((fn.part + line) % 11, 2);
    const valueB = pad((fn.part + line + 5) % 11, 2);
    const localA = pad(line % 4, 2);
    const localB = pad((line + 1) % 4, 2);
    if (line % globalAccessStride === 0) {
      lines.push(
        `${indent}g_mod_${moduleA}_value_${valueA} += g_mod_${moduleB}_value_${valueB} + local_${localA} + local_${localB} + seed;`
      );
    } else {
      lines.push(
        `${indent}local_${localA} += local_${localB} + seed + ${line}; ${renderProbeCalls(fn.index, line)}`
      );
    }
  }
  lines.push(`${indent}${nextA.name}(seed + 1);`);
  lines.push(`${indent}if ((seed & 3) == 0) { ${nextB.name}(seed + 2); }`);
  lines.push(`${indent}if ((seed & 7) == 0) { ${nextC.name}(seed + 3); }`);
  for (let depth = nestDepth - 1; depth >= 0; depth -= 1) {
    lines.push(`${"    ".repeat(depth + 1)}}`);
  }
  lines.push("}");
  lines.push(markerEnd);
  lines.push("");
  return lines.join("\n");
}

function renderProbeCalls(functionIndex, line) {
  const calls = [];
  for (let probe = 0; probe < probeCallsPerLine; probe += 1) {
    const probeName = `StressProbe_${pad(functionIndex % 10000, 4)}_${pad(line, 3)}_${pad(probe, 3)}`;
    calls.push(`${probeName}(local_${pad(probe % 4, 2)}, local_${pad((probe + 1) % 4, 2)}, seed);`);
  }
  return calls.join(" ");
}

async function ensureGlobalsInclude(file) {
  let text = await fs.readFile(file, "utf8");
  if (text.includes('#include "stress_relations.h"')) {
    return;
  }
  text = text.replace(/#include "struct_members\.h"\r?\n/, (match) => `${match}#include "stress_relations.h"\n`);
  await fs.writeFile(file, text, "utf8");
}

async function ensureDspSources(rootDir) {
  const dsp = (await fs.readdir(rootDir)).find((name) => name.toLowerCase().endsWith(".dsp"));
  if (!dsp) {
    return;
  }
  const file = path.join(rootDir, dsp);
  let text = await fs.readFile(file, "utf8");
  text = ensureDspSource(text, ".\\src\\stress_relations.h");
  text = ensureDspSource(text, ".\\src\\stress_relations.cpp");
  await fs.writeFile(file, text, "utf8");
}

function ensureDspSource(text, sourcePath) {
  if (text.includes(`SOURCE=${sourcePath}`)) {
    return text;
  }
  const block = ["# Begin Source File", `SOURCE=${sourcePath}`, "# End Source File", ""].join("\n");
  return text.replace("# Begin Source File", `${block}# Begin Source File`);
}

async function ensureThreadCalls(file) {
  let text = await fs.readFile(file, "utf8");
  for (let index = 0; index < 16; index += 1) {
    text = ensureCall(text, `ThreadEntry_${pad(index, 2)}`, `StressEntry_${pad(index, 2)}(step);`);
  }
  await fs.writeFile(file, text, "utf8");
}

function ensureCall(text, entryName, callLine) {
  const start = text.indexOf(`unsigned long ${entryName}`);
  if (start < 0) {
    return text;
  }
  const end = text.indexOf("\n}\n", start);
  const functionText = text.slice(start, end > start ? end : undefined);
  if (functionText.includes(callLine)) {
    return text;
  }
  const pattern = new RegExp(`(unsigned long ${entryName}\\([^)]*\\)\\r?\\n\\{\\r?\\n\\s*int step = \\(int\\)\\(long\\)param;\\r?\\n)`);
  return text.replace(pattern, `$1    ${callLine}\n`);
}

function replaceGeneratedBlock(current, block) {
  const start = current.indexOf(markerStart);
  const end = current.indexOf(markerEnd);
  if (start >= 0 && end > start) {
    const after = end + markerEnd.length;
    return `${current.slice(0, start).trimEnd()}\n\n${block}${current.slice(after).trimStart()}`;
  }
  return `${current.trimEnd()}\n\n${block}`;
}

async function writeIfChanged(file, text) {
  try {
    if ((await fs.readFile(file, "utf8")) === text) {
      return;
    }
  } catch {
    // create below
  }
  await fs.writeFile(file, text, "utf8");
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function totalSourceBytes(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.(c|cc|cpp|cxx|h|hh|hpp|inl)$/i.test(entry.name)) {
      continue;
    }
    total += (await fs.stat(path.join(dir, entry.name))).size;
  }
  return total;
}

function estimateLegacyMemoryBytes(fileCount, lineCount, probesPerLine) {
  const identifiersPerLine = probesPerLine * 4 + 8;
  const lineBytes = probesPerLine * 34 + 110;
  const bodyLineOverhead = 192;
  const stringAllocationBytes = 72;
  const rawMaskedBytes = lineBytes * 2 + 96;
  const identifierBytes = identifiersPerLine * stringAllocationBytes;
  return fileCount * lineCount * (bodyLineOverhead + rawMaskedBytes + identifierBytes);
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
