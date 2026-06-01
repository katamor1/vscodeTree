# VC6 Impact Review

Rust native analysis powered VS Code extension for reviewing changes in large VC6 C/C++ projects with many globals and thread contexts.

The extension builds a local JSON index from `.dsw` / `.dsp` files and source files, maps configured thread entry functions, and generates Japanese Markdown plus HTML relationship reports. Artifacts are grouped under `.vscode/vc6-impact-review/` in the opened workspace by default and are added to `.git/info/exclude` when possible.

## Parser Engines

The production default is the bundled Rust native sidecar, but the parser engine can be switched when troubleshooting source patterns that Rust does not handle well:

- `rust`: calls `native/vc6-impact-rust` with `analyze-many`. This is the default and fastest production path.
- `typescript`: uses a local TypeScript scanner and emits the same JSON index shape.
- `clang`: collects clang syntax diagnostics when clang is available, then uses the TypeScript extraction path for the JSON index shape.
- `analyze-many` uses the low-memory native path by default: pass 1 collects symbol summaries, pass 2 analyzes bounded batches and writes JSON through `--output`.
- If `parserEngine` is `rust` and the Rust sidecar is missing, indexing fails clearly instead of silently falling back.
- Source and project file decoding defaults to automatic fallback: UTF-8 BOM, UTF-8, then CP932.

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
  "vc6Impact.outputDir": "",
  "vc6Impact.parserEngine": "rust",
  "vc6Impact.maxNativeBatchFiles": 4,
  "vc6Impact.maxRustAutoSkippedFiles": 16,
  "vc6Impact.projectEncoding": "auto",
  "vc6Impact.sourceEncoding": "auto"
}
```

If `outputDir` is empty, artifacts are written to `.vscode/vc6-impact-review/`. Reports are overwritten per symbol under `reports/`.

`projectEncoding` applies to `.dsw` / `.dsp`; `sourceEncoding` applies to C/C++ files scanned by the Rust sidecar. Use `auto` unless a project must be forced to `utf8` or `cp932`.

`maxNativeBatchFiles` bounds how many source files the Rust access-analysis pass may retain at once. Lower it to `1` for the smallest memory footprint, or raise it cautiously to trade memory for throughput.

If the Rust sidecar fails with an out-of-memory/allocation-class error, the extension retries in safe mode with one worker and one source file per batch. The safe retry writes per-file RSS progress under `.vscode/vc6-impact-review/native-diagnostics/`, skips only the file identified as failing, records that skip in the index build diagnostics, and continues until `maxRustAutoSkippedFiles` is reached. Set `maxRustAutoSkippedFiles` to `0` to keep memory failures hard-fail only.

## Development Checks

```powershell
cargo test --manifest-path native/vc6-impact-rust/Cargo.toml
cargo build --release --manifest-path native/vc6-impact-rust/Cargo.toml
npm run check
npm run bench:index -- large
npx @vscode/vsce package --allow-missing-repository
```
