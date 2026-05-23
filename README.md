# VC6 Impact Review

Rust native analysis powered VS Code extension for reviewing changes in large VC6 C/C++ projects with many globals and thread contexts.

The extension builds a local JSON index from `.dsw` / `.dsp` files and source files, maps configured thread entry functions, and generates Japanese Markdown plus HTML relationship reports. Artifacts are grouped under `.vscode/vc6-impact-review/` in the opened workspace by default and are added to `.git/info/exclude` when possible.

## Production Parser

The production build uses only the bundled Rust native sidecar:

- Normal indexing always calls `native/vc6-impact-rust` with `analyze-many`.
- Alternative parser switching is not part of the production command surface.
- If the Rust sidecar is missing, indexing fails clearly instead of falling back to a TypeScript parser.

## Commands

- `VC6 Impact: Build Full Index`
- `VC6 Impact: Update Index`
- `VC6 Impact: Inspect Selected Symbol`
- `VC6 Impact: Generate Review Report`
- `VC6 Impact: Open Graph`

## Install / Reload Notes

After installing a rebuilt VSIX, run `Developer: Reload Window` or restart VS Code before using the commands. VS Code can keep the old extension host alive after a reinstall, especially when replacing the same extension during development; that stale state can surface as `command 'vc6Impact.buildFullIndex' not found` even when the VSIX manifest contains the command.

The extension also activates on `onStartupFinished`, so after reload the command handlers are registered before you open the VC6 Impact view or run the command palette entry.

## Minimum Settings

```json
{
  "vc6Impact.projectFile": "path/to/project.dsw",
  "vc6Impact.threadMapFile": "path/to/thread-map.json",
  "vc6Impact.outputDir": ""
}
```

If `outputDir` is empty, artifacts are written to `.vscode/vc6-impact-review/`. Reports are overwritten per symbol under `reports/`.

## Development Checks

```powershell
cargo test --manifest-path native/vc6-impact-rust/Cargo.toml
cargo build --release --manifest-path native/vc6-impact-rust/Cargo.toml
npm run check
npm run bench:index -- large
npx @vscode/vsce package --allow-missing-repository
```
