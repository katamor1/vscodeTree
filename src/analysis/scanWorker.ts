import { parentPort, workerData } from "node:worker_threads";
import { scanFileStructure } from "./sourceScanner";
import type { FileStructure } from "./fileStructure";

interface ScanWorkerData {
  files: string[];
}

async function main(): Promise<void> {
  const data = workerData as ScanWorkerData;
  const structures: FileStructure[] = [];
  for (const file of data.files) {
    structures.push(await scanFileStructure(file));
  }
  parentPort?.postMessage({ ok: true, structures });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  parentPort?.postMessage({ ok: false, error: message });
});
