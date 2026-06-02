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

  it("shows the sidebar view only for VC6 project workspaces and editor context commands only for C/C++ source files", async () => {
    const manifestPath = path.resolve(__dirname, "..", "package.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      activationEvents?: string[];
      contributes?: {
        menus?: {
          "editor/context"?: Array<{ command: string; when?: string }>;
          "view/title"?: Array<{ command: string; when?: string }>;
        };
        views?: {
          vc6Impact?: Array<{ id: string; when?: string }>;
        };
      };
    };

    expect(manifest.activationEvents).toContain("workspaceContains:**/*.dsw");
    expect(manifest.activationEvents).toContain("workspaceContains:**/*.dsp");

    const views = manifest.contributes?.views?.vc6Impact ?? [];
    expect(views.find((view) => view.id === "vc6Impact.explorer")?.when).toBe("vc6Impact.hasProject");

    for (const menu of manifest.contributes?.menus?.["editor/context"] ?? []) {
      expect(menu.when).toContain("vc6Impact.hasProject");
      expect(menu.when).toContain("resourceLangId == c");
      expect(menu.when).toContain("resourceLangId == cpp");
      expect(menu.when).not.toContain("markdown");
    }

    for (const menu of manifest.contributes?.menus?.["view/title"] ?? []) {
      expect(menu.when).toContain("vc6Impact.hasProject");
    }
  });

  it("exposes the production command surface with selectable parser engines", async () => {
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
    expect(manifest.contributes?.configuration?.properties).toHaveProperty("vc6Impact.parserEngine");
    expect(manifest.scripts?.["compare:parsers"]).toBeUndefined();
  });
});
