const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { buildFullIndex } = require("../dist/analysis/indexer");

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
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sample = samples[args.sample || "small"];
  if (!sample) {
    throw new Error(`Unknown sample: ${args.sample}`);
  }
  await ensureCompiled();
  const started = performance.now();
  const index = await buildFullIndex({
    workspaceRoot: sample.root,
    projectFile: path.join(sample.root, sample.project),
    threadMapFile: path.join(sample.root, sample.threadMap),
    maxIndexWorkers: args.workers === undefined ? 0 : Number(args.workers)
  });
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    sample: args.sample || "small",
    parserEngine: "rust-native",
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
    macros: Object.keys(index.macroAliases || {}).length,
    threads: index.threads.length,
    reachability: Object.keys(index.threadReachability).length,
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024)
  }, null, 2));
}

function roundMb(bytes) {
  return Math.round((Number(bytes) / 1024 / 1024) * 10) / 10;
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
