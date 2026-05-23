import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { scanFileStructure } from "./sourceScanner";
import type { FileStructure } from "./fileStructure";

export interface ScanFileStructuresResult {
  structures: FileStructure[];
  workerCount: number;
  usedWorkers: boolean;
}

export async function scanFileStructures(
  files: string[],
  maxIndexWorkers = 0
): Promise<ScanFileStructuresResult> {
  const workerCount = resolveIndexWorkerCount(files.length, maxIndexWorkers);
  if (workerCount <= 1 || !(await canUseCompiledWorker())) {
    return {
      structures: await scanInProcess(files),
      workerCount: 1,
      usedWorkers: false
    };
  }

  const chunks = chunkRoundRobin(files, workerCount);
  const structuresByChunk = await Promise.all(chunks.map((chunk) => scanInWorker(chunk)));
  return {
    structures: structuresByChunk.flat(),
    workerCount,
    usedWorkers: true
  };
}

export function resolveIndexWorkerCount(fileCount: number, maxIndexWorkers = 0): number {
  if (fileCount <= 1) {
    return 1;
  }
  if (maxIndexWorkers > 0) {
    return Math.max(1, Math.min(Math.floor(maxIndexWorkers), fileCount));
  }
  return Math.max(1, Math.min(Math.max(1, os.cpus().length - 1), fileCount));
}

async function canUseCompiledWorker(): Promise<boolean> {
  try {
    await fs.access(workerPath());
    return true;
  } catch {
    return false;
  }
}

async function scanInProcess(files: string[]): Promise<FileStructure[]> {
  const structures: FileStructure[] = [];
  for (const file of files) {
    structures.push(await scanFileStructure(file));
  }
  return structures;
}

function scanInWorker(files: string[]): Promise<FileStructure[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath(), { workerData: { files } });
    worker.once("message", (message: WorkerMessage) => {
      if (message.ok) {
        resolve(message.structures);
      } else {
        reject(new Error(message.error));
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Index worker exited with code ${code}`));
      }
    });
  });
}

function chunkRoundRobin(files: string[], workerCount: number): string[][] {
  const chunks = Array.from({ length: workerCount }, () => [] as string[]);
  files.forEach((file, index) => {
    chunks[index % workerCount]!.push(file);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

function workerPath(): string {
  return path.join(__dirname, "scanWorker.js");
}

type WorkerMessage =
  | { ok: true; structures: FileStructure[] }
  | { ok: false; error: string };
