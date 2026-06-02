import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { hasVc6ProjectFolder } from "../src/extension/workspaceContext";

describe("workspace context", () => {
  it("detects a VC6 project file in the opened workspace root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-context-"));
    await fs.writeFile(path.join(root, "sample.dsw"), 'Project: "sample"="sample.dsp" - Package Owner=<4>\r\n', "utf8");

    await expect(hasVc6ProjectFolder(root, "")).resolves.toBe(true);
  });

  it("accepts an existing configured VC6 project file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-context-"));
    await fs.mkdir(path.join(root, "project"));
    await fs.writeFile(path.join(root, "project", "sample.dsp"), "SOURCE=.\\main.c\r\n", "utf8");

    await expect(hasVc6ProjectFolder(root, "project/sample.dsp")).resolves.toBe(true);
  });

  it("does not enable VC6 UI from a configured project file outside the opened folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-context-"));
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-other-project-"));
    const projectFile = path.join(projectRoot, "sample.dsp");
    await fs.writeFile(projectFile, "SOURCE=.\\main.c\r\n", "utf8");

    await expect(hasVc6ProjectFolder(root, projectFile)).resolves.toBe(false);
  });

  it("does not enable VC6 UI for non-project folders or non-project configured files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vc6-impact-context-"));
    await fs.writeFile(path.join(root, "notes.txt"), "not a VC6 project", "utf8");

    await expect(hasVc6ProjectFolder(root, "")).resolves.toBe(false);
    await expect(hasVc6ProjectFolder(root, "notes.txt")).resolves.toBe(false);
  });
});
