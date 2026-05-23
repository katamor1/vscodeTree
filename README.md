# VC6 Impact Review

VS Code extension prototype for reviewing changes in large VC6 C/C++ projects with many globals and thread contexts.

The extension builds a local JSON index from `.dsw` / `.dsp` files and source files, maps configured thread entry functions, and generates Japanese Markdown plus HTML relationship reports. It does not write to the target source tree unless you explicitly configure the output directory inside that tree.

## Commands

- `VC6 Impact: Build Full Index`
- `VC6 Impact: Update Index`
- `VC6 Impact: Inspect Selected Symbol`
- `VC6 Impact: Generate Review Report`
- `VC6 Impact: Open Graph`

## Minimum Settings

```json
{
  "vc6Impact.projectFile": "path/to/project.dsw",
  "vc6Impact.threadMapFile": "path/to/thread-map.json",
  "vc6Impact.outputDir": "C:/review-output/vc6-impact",
  "vc6Impact.parserMode": "standard"
}
```

If `outputDir` is empty, VS Code global storage is used so the target VC6 source tree remains read-only.

`parserMode` defaults to `standard`. Set it to `custom` to use the isolated implementation under `src/analysis/customParser/` without replacing the standard scanner route.
