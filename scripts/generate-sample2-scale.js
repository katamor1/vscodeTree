const fs = require("node:fs/promises");
const path = require("node:path");

const defaultBaseRoot = "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-base";
const defaultOutputRoot = "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-scale-7000";
const defaultSourceEntries = 7000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRoot = path.resolve(args.base || process.env.VC6_IMPACT_SAMPLE2_BASE || defaultBaseRoot);
  const outputRoot = path.resolve(args.output || process.env.VC6_IMPACT_SAMPLE2_SCALE || defaultOutputRoot);
  const sourceEntries = Number(args.entries || process.env.VC6_IMPACT_SAMPLE2_ENTRIES || defaultSourceEntries);

  await ensureBaseMetadata(baseRoot);
  if (!args.baseOnly) {
    await generateScaleSample(baseRoot, outputRoot, sourceEntries);
  }

  console.log(JSON.stringify({
    baseRoot: slash(baseRoot),
    outputRoot: args.baseOnly ? undefined : slash(outputRoot),
    sourceEntries,
    baseOnly: Boolean(args.baseOnly)
  }, null, 2));
}

async function ensureBaseMetadata(root) {
  const entries = await sourceEntriesForRoot(root);
  await writeIfChanged(
    path.join(root, "sample2_base.dsp"),
    renderDsp("sample2_base", "PERF_SAMPLE2_BASE", entries)
  );
  await writeIfChanged(path.join(root, "sample2_base.dsw"), renderDsw("sample2_base", "sample2_base.dsp"));
  await writeIfChanged(path.join(root, "thread-map.json"), `${JSON.stringify(sample2ThreadMap(), null, 2)}\n`);
  await writeManifest(root, {
    scale: "base",
    sourceEntriesInDsp: entries.length,
    projectFileName: "sample2_base.dsw",
    threadMapFileName: "thread-map.json",
    generatedFileCount: 0,
    note: "Hand-authored sample2 analyzer fixture. VC6 compile/link success is not claimed because main.c intentionally contains duplicate thread_sub1ptr definitions."
  });
}

async function generateScaleSample(baseRoot, outputRoot, sourceEntries) {
  const baseEntries = await sourceEntriesForRoot(baseRoot);
  if (sourceEntries < baseEntries.length) {
    throw new Error(`--entries must be at least ${baseEntries.length} because all base source files are included`);
  }
  assertSafeScaleOutput(outputRoot);
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(outputRoot, "src"), { recursive: true });
  for (const entry of baseEntries) {
    const relative = entry.replace(/^src\//, "");
    await fs.copyFile(path.join(baseRoot, "src", relative), path.join(outputRoot, "src", relative));
  }

  const generatedCount = sourceEntries - baseEntries.length;
  const generatedEntries = [];
  for (let index = 0; index < generatedCount; index += 1) {
    const fileName = `sample2_scale_${pad(index, 4)}.c`;
    generatedEntries.push(`src/${fileName}`);
    await fs.writeFile(path.join(outputRoot, "src", fileName), renderGeneratedSource(index, generatedCount), "utf8");
  }

  const entries = [...baseEntries, ...generatedEntries];
  await writeIfChanged(
    path.join(outputRoot, "sample2_scale.dsp"),
    renderDsp("sample2_scale", "PERF_SAMPLE2_SCALE", entries)
  );
  await writeIfChanged(path.join(outputRoot, "sample2_scale.dsw"), renderDsw("sample2_scale", "sample2_scale.dsp"));
  await writeIfChanged(path.join(outputRoot, "thread-map.json"), `${JSON.stringify(sample2ThreadMap(), null, 2)}\n`);
  await writeManifest(outputRoot, {
    scale: `generated ${sourceEntries}-entry sample from vc6-large-sample2-base`,
    sourceEntriesInDsp: entries.length,
    projectFileName: "sample2_scale.dsw",
    threadMapFileName: "thread-map.json",
    generatedFileCount: generatedCount,
    baseRoot: slash(baseRoot),
    note: "Generated outside vscodeTree so it is not managed by that repository. Use as a read-only performance fixture."
  });
}

function renderGeneratedSource(index, generatedCount) {
  const next = (index + 1) % generatedCount;
  const sub = (index % 4) + 1;
  const valueA = (index % 200) + 1;
  const valueB = ((index + 10) % 200) + 1;
  const valueC = ((index + 20) % 200) + 1;
  return [
    '#include "header.h"',
    "",
    "extern SAMPLE_SUBSUB subLocal;",
    "extern SAMPLE_MAIN* PTR_GBL;",
    "extern SAMPLE_BUFFER* PTR_BUFF;",
    "",
    `void sample2_scale_func_${pad(next, 4)}(int step);`,
    "",
    `void sample2_scale_func_${pad(index, 4)}(int step)`,
    "{",
    `    PTR_GBL->sub${sub}.sample_value${valueA} += step;`,
    `    PTR_GBL->sub4.subsub_ptr->sample_value${valueB}++;`,
    `    (PTR_BUFF + ${index % 8})->sample_value${valueC}++;`,
    "    if ((step & 3) == 0) {",
    `        sample2_scale_func_${pad(next, 4)}(step + 1);`,
    "    }",
    "}",
    ""
  ].join("\n");
}

function renderDsp(projectName, macroName, sourceEntries) {
  const lines = [
    `# Microsoft Developer Studio Project File - Name="${projectName}" - Package Owner=<4>`,
    "# Microsoft Developer Studio Generated Build File, Format Version 6.00",
    `# ADD CPP /nologo /W3 /GX /I ".\\src" /D "WIN32" /D "${macroName}" /D "_DEBUG" /YX /FD /c`,
    "",
    '# Begin Group "Generated Files"'
  ];
  for (const source of sourceEntries) {
    lines.push("# Begin Source File");
    lines.push(`SOURCE=.\\${source.replace(/\//g, "\\")}`);
    lines.push("# End Source File");
  }
  lines.push("# End Group");
  lines.push("");
  return lines.join("\r\n");
}

function renderDsw(projectName, dspName) {
  return [
    "Microsoft Developer Studio Workspace File, Format Version 6.00",
    "# WARNING: DO NOT EDIT OR DELETE THIS WORKSPACE FILE!",
    "",
    "###############################################################################",
    "",
    `Project: "${projectName}"=".\\${dspName}" - Package Owner=<4>`,
    "",
    "Package=<5>",
    "{{{",
    "}}}",
    "",
    "Package=<4>",
    "{{{",
    "}}}",
    "",
    "###############################################################################",
    "",
    "Global:",
    "",
    "Package=<5>",
    "{{{",
    "}}}",
    "",
    "Package=<3>",
    "{{{",
    "}}}",
    "",
    "###############################################################################",
    ""
  ].join("\r\n");
}

function sample2ThreadMap() {
  return {
    threads: [
      {
        threadId: "sample2_main",
        entryFunction: "thread_main_entry",
        priority: "normal",
        cycle: "startup",
        isInterruptLike: false,
        notes: "initializes pointer-heavy sample globals"
      },
      {
        threadId: "sample2_worker_1",
        entryFunction: "thread1_entry",
        priority: "normal",
        cycle: "10ms",
        isInterruptLike: false,
        notes: "sample worker thread"
      },
      {
        threadId: "sample2_worker_2",
        entryFunction: "thread2_entry",
        priority: "normal",
        cycle: "10ms",
        isInterruptLike: false,
        notes: "sample worker thread"
      },
      {
        threadId: "sample2_irq",
        entryFunction: "thread3_entry",
        priority: "hardware",
        cycle: "interrupt",
        isInterruptLike: true,
        notes: "interrupt-like sample thread"
      }
    ]
  };
}

async function writeManifest(root, metadata) {
  const sourceFiles = await listSourceFiles(path.join(root, "src"));
  const totalFiles = await countFiles(root);
  await writeIfChanged(
    path.join(root, "manifest.json"),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      root: slash(root),
      ...metadata,
      sourceFilesOnDisk: sourceFiles.length,
      totalFilesOnDisk: totalFiles,
      projectFile: slash(path.join(root, metadata.projectFileName)),
      threadMapFile: slash(path.join(root, metadata.threadMapFileName))
    }, null, 2)}\n`
  );
}

async function listSourceFiles(srcDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(c|cc|cpp|cxx|h|hh|hpp|inl)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareSourceNames);
}

async function sourceEntriesForRoot(root) {
  return (await listSourceFiles(path.join(root, "src"))).map((name) => `src/${name}`);
}

function compareSourceNames(left, right) {
  const rank = (name) => {
    if (name.toLowerCase() === "main.c") {
      return 0;
    }
    if (name.toLowerCase() === "header.h") {
      return 1;
    }
    return 2;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

async function countFiles(root) {
  let count = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(fullPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function assertSafeScaleOutput(outputRoot) {
  const normalized = slash(path.resolve(outputRoot)).toLowerCase();
  const expectedParent = slash(path.resolve("C:/Users/stell/source/repos/vscodeTree_perf_samples")).toLowerCase();
  const basename = path.basename(outputRoot).toLowerCase();
  if (!normalized.startsWith(`${expectedParent}/`) || !basename.startsWith("vc6-large-sample2-scale-")) {
    throw new Error(`Refusing to delete unexpected output directory: ${outputRoot}`);
  }
}

async function writeIfChanged(file, text) {
  try {
    if ((await fs.readFile(file, "utf8")) === text) {
      return;
    }
  } catch {
    // create below
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      result.base = argv[++index];
    } else if (arg === "--output") {
      result.output = argv[++index];
    } else if (arg === "--entries") {
      result.entries = argv[++index];
    } else if (arg === "--base-only") {
      result.baseOnly = true;
    }
  }
  return result;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function slash(value) {
  return value.replace(/\\/g, "/");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
