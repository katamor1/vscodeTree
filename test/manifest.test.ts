import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("extension manifest", () => {
  it("activates both on startup and for every contributed command", async () => {
    const manifestPath = path.resolve(__dirname, "..", "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command: string }>;
      };
    };

    const activationEvents = manifest.activationEvents ?? [];
    const commands = manifest.contributes?.commands ?? [];

    expect(activationEvents).toContain("onStartupFinished");
    for (const command of commands) {
      expect(activationEvents).toContain(`onCommand:${command.command}`);
    }
  });

  it("uses icon-sized actions for the VC6 Impact view title toolbar", async () => {
    const manifestPath = path.resolve(__dirname, "..", "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      contributes?: {
        commands?: Array<{ command: string; icon?: string; shortTitle?: string }>;
        menus?: {
          "view/title"?: Array<{ command: string }>;
        };
      };
    };

    const commandById = new Map((manifest.contributes?.commands ?? []).map((command) => [command.command, command]));
    const viewTitleCommands = manifest.contributes?.menus?.["view/title"] ?? [];

    expect(viewTitleCommands.length).toBeGreaterThan(0);
    for (const menuCommand of viewTitleCommands) {
      const command = commandById.get(menuCommand.command);
      expect(command?.icon).toMatch(/^\$\([^)]+\)$/);
      expect(command?.shortTitle).toBeTruthy();
    }
  });

  it("uses a dedicated single-color SVG for the activity bar container", async () => {
    const manifestPath = path.resolve(__dirname, "..", "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      contributes?: {
        viewsContainers?: {
          activitybar?: Array<{ id: string; icon?: string }>;
        };
      };
    };

    const activityBarContainer = manifest.contributes?.viewsContainers?.activitybar?.find(
      (container) => container.id === "vc6Impact"
    );

    expect(activityBarContainer?.icon).toBe("resources/activitybar.svg");
  });

  it("exposes only the Rust production command surface", async () => {
    const manifestPath = path.resolve(__dirname, "..", "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command: string }>;
        configuration?: { properties?: Record<string, unknown> };
        menus?: { "view/title"?: Array<{ command: string }> };
      };
      scripts?: Record<string, string>;
    };

    const commandIds = (manifest.contributes?.commands ?? []).map((command) => command.command).sort();
    expect(commandIds).toEqual([
      "vc6Impact.buildFullIndex",
      "vc6Impact.generateReviewReport",
      "vc6Impact.inspectSelectedSymbol",
      "vc6Impact.openGraph",
      "vc6Impact.updateIndex"
    ].sort());

    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("vc6Impact.parserMode");
    expect(serialized).not.toContain("vc6Impact.compareParserBackends");
    expect(serialized).not.toContain("Compare Parser Backends");
    expect(serialized).not.toContain("\"standard\"");
    expect(serialized).not.toContain("\"custom\"");
    expect(serialized).not.toContain("\"clang\"");
    expect(manifest.scripts?.["compare:parsers"]).toBeUndefined();
  });
});
