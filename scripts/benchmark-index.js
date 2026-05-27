const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const perfSamplesRoot = "C:/Users/stell/source/repos/vscodeTree_perf_samples";

const samples = {
  fixture: {
    root: "C:/Users/stell/source/repos/vscodeTree/test/fixtures/vc6-sample",
    project: "sample.dsw",
    threadMap: "thread-map.json"
  },
  small: {
    root: "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-small-sample-1of50",
    project: "small_sample.dsw",
    threadMap: "thread-map.json"
  },
  large: {
    root: "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample",
    project: "large_sample.dsw",
    threadMap: "thread-map.json"
  },
  "sample2-base": {
    root: "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample2-base",
    project: "sample2_base.dsw",
    threadMap: "thread-map.json"
  },
  "sample2-scale": {
    root: sample2ScaleRoot(7000),
    project: "sample2_scale.dsw",
    threadMap: "thread-map.json"
  },
  "sample2-scale-7000": {
    root: sample2ScaleRoot(7000),
    project: "sample2_scale.dsw",
    threadMap: "thread-map.json"
  },
  "sample2-scale-16000": {
    root: sample2ScaleRoot(16000),
    project: "sample2_scale.dsw",
    threadMap: "thread-map.json"
  },
  "sample2-scale-31000": {
    root: sample2ScaleRoot(31000),
    project: "sample2_scale.dsw",
    threadMap: "thread-map.json"
  }
};

async function main() {
  const { buildFullIndex } = require("../dist/analysis/indexer");
  const args = parseArgs(process.argv.slice(2));
  const sample = samples[args.sample || "small"];
  if (!sample) {
    throw new Error(`Unknown sample: ${args.sample}`);
  }
  await ensureCompiled();
  const manifest = await readJsonIfExists(path.join(sample.root, "manifest.json"));
  const started = performance.now();
  const index = await buildFullIndex({
    workspaceRoot: sample.root,
    projectFile: path.join(sample.root, sample.project),
    threadMapFile: path.join(sample.root, sample.threadMap),
    maxIndexWorkers: args.workers === undefined ? 0 : Number(args.workers),
    maxNativeBatchFiles: args.batch === undefined ? undefined : Number(args.batch),
    parserEngine: args.parser
  });
  const memory = process.memoryUsage();
  const report = {
    sample: args.sample || "small",
    parserEngine: index.build.parserMode,
    wallMs: Math.round(performance.now() - started),
    reportedDurationMs: index.build.durationMs,
    phaseDurationsMs: index.build.phaseDurationsMs,
    workerCount: index.build.workerCount,
    nativeBatchSize: index.build.phaseDurationsMs.rustBatchSize ?? 0,
    nativeOutputMb: roundMb(index.build.phaseDurationsMs.rustOutputBytes ?? 0),
    nativePeakRssMb: roundMb(index.build.phaseDurationsMs.rustPeakRssBytes ?? 0),
    sourceFileCount: index.build.sourceFileCount,
    globals: Object.keys(index.globals).length,
    structTypes: Object.keys(index.structTypes).length,
    memberSymbols: Object.keys(index.memberSymbols).length,
    functions: Object.keys(index.functions).length,
    functionAccesses: countFunctionAccesses(index),
    macros: Object.keys(index.macroAliases || {}).length,
    threads: index.threads.length,
    reachability: Object.keys(index.threadReachability).length,
    projectedIndexSizeMiB: manifest?.projectedIndexSizeMiB,
    targetIndexSizeMiB: manifest?.targetIndexSizeMiB,
    calibratedFrom: manifest?.calibratedFrom,
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024)
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await fs.writeFile(args.output, text, "utf8");
  }
  console.log(text.trimEnd());
}

function roundMb(bytes) {
  return Math.round((Number(bytes) / 1024 / 1024) * 10) / 10;
}

function sample2ScaleRoot(entries) {
  return `${perfSamplesRoot}/vc6-large-sample2-scale-${entries}`;
}

function countFunctionAccesses(index) {
  return Object.values(index.functions).reduce((sum, func) => sum + (func.accesses?.length ?? 0), 0);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const result = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sample") {
      result.sample = argv[++index];
    } else if (arg === "--workers") {
      result.workers = argv[++index];
    } else if (arg === "--output") {
      result.output = argv[++index];
    } else if (arg === "--batch") {
      result.batch = argv[++index];
    } else if (arg === "--parser") {
      result.parser = argv[++index];
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  result.sample ??= positional[0];
  result.workers ??= positional[1];
  return result;
}

async function ensureCompiled() {
  const extensionJs = path.resolve(__dirname, "..", "dist", "analysis", "indexer.js");
  try {
    await fs.access(extensionJs);
  } catch {
    throw new Error("dist/analysis/indexer.js is missing. Run npm run compile before benchmarking.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  countFunctionAccesses,
  roundMb,
  sample2ScaleRoot,
  samples
};
