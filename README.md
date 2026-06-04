# VC6 影響レビュー

大規模な VC6 C/C++ プロジェクトで、グローバル変数と関数の影響範囲を確認するための VS Code 拡張です。

この拡張は `.dsw` / `.dsp` とソースファイルからローカル JSON インデックスを作成し、設定したスレッド入口関数を対応付け、影響関係を日本語 Markdown と HTML レポートとして生成します。成果物は既定で開いているワークスペースの `.vscode/vc6-impact-review/` にまとめられ、可能な場合は `.git/info/exclude` に追加されます。

## 機能

- VC6 の `.dsw` / `.dsp` を読み取り、選択した構成のコンパイル対象と定義を解析します。
- グローバル変数、構造体メンバー、マクロ、関数の参照関係をインデックス化します。
- 選択中のデータシンボルについてアクセス箇所を表示し、関数シンボルについては呼び出し関係とスレッド文脈を中心にツリービューへ表示します。
- 複数スレッドからの書き込み候補、read/write 干渉候補、割込み系スレッド文脈の関与などのレビュー観点を提示します。
- 影響関係を Markdown レポートと HTML グラフとして出力します。
- Rust ネイティブ解析を既定の本番経路とし、トラブルシューティング用に TypeScript / clang 経路へ切り替えられます。
- 対象ソースツリーを書き換えず、インデックスとレポートだけをワークスペース配下に出力します。

## パーサーエンジン

既定では同梱の Rust ネイティブサイドカーを使います。Rust で扱いにくいソースパターンを調査する場合は、設定からパーサーエンジンを切り替えられます。

- `rust`: `native/vc6-impact-rust` の `analyze-many` を呼び出します。既定かつ最速の本番向け経路です。
- `typescript`: ローカルの TypeScript スキャナーを使い、同じ JSON インデックス形式を出力します。
- `clang`: clang が利用できる場合に構文診断を収集し、JSON インデックスは TypeScript 抽出経路で作成します。
- `analyze-many` は低メモリのネイティブ経路を既定で使います。1 パス目でシンボル概要を収集し、2 パス目で制限付きバッチを解析して `--output` へ JSON を書き込みます。
- `parserEngine` が `rust` で Rust サイドカーが見つからない場合は、黙ってフォールバックせず明確に失敗します。
- プロジェクトファイルとソースファイルの文字コードは、既定で UTF-8 BOM、UTF-8、CP932 の順に自動判定します。

## コマンド

主なコマンド:

- `VC6 Impact: フルインデックスを作成`
- `VC6 Impact: インデックスを更新`
- `VC6 Impact: 選択シンボルを調査`
- `VC6 Impact: レビューレポートを生成`
- `VC6 Impact: グラフを開く`

エディターでシンボルを選択して、コンテキストメニューから調査またはレポート生成を実行できます。サイドバーの `VC6 影響` ビューからは、インデックス作成と更新を実行できます。

## インストール後の注意

再ビルドした VSIX をインストールした後は、`Developer: Reload Window` を実行するか VS Code を再起動してください。同じ拡張を開発中に差し替える場合、VS Code が古い拡張ホストを保持し、VSIX の manifest にコマンドが含まれていても `command 'vc6Impact.buildFullIndex' not found` が出ることがあります。

この拡張は `onStartupFinished` でも有効化されるため、リロード後は `VC6 影響` ビューを開く前やコマンドパレットから実行する前にコマンドハンドラーが登録されます。

## 最小設定

```json
{
  "vc6Impact.projectFile": "path/to/project.dsw",
  "vc6Impact.projectConfiguration": "Release",
  "vc6Impact.threadMapFile": "path/to/thread-map.json",
  "vc6Impact.outputDir": "",
  "vc6Impact.parserEngine": "rust",
  "vc6Impact.maxNativeBatchFiles": 4,
  "vc6Impact.maxRustAutoSkippedFiles": 16,
  "vc6Impact.rustSidecarTimeoutMs": -1,
  "vc6Impact.projectEncoding": "auto",
  "vc6Impact.sourceEncoding": "auto"
}
```

`outputDir` が空の場合、成果物は `.vscode/vc6-impact-review/` に書き込まれます。レポートはシンボル単位で `reports/` 配下に上書き保存されます。

`projectEncoding` は `.dsw` / `.dsp` に適用され、`sourceEncoding` は Rust サイドカーが走査する C/C++ ファイルに適用されます。特定プロジェクトで `utf8` または `cp932` を強制する必要がない限り、`auto` を使います。

`projectConfiguration` は `.dsp` のコンパイルスイッチを読むときに使う VC6 の `$(CFG)` ブランチを選択します。既定は `Release` なので、明示的に切り替えない限り Debug や単体テスト専用の `/D` はリリース向け影響インデックスに混ざりません。

`maxNativeBatchFiles` は、Rust のアクセス解析パスが一度に保持するソースファイル数を制限します。メモリ使用量を最小にする場合は `1` に下げ、メモリと引き換えに速度を上げたい場合のみ慎重に増やしてください。

Rust サイドカーがメモリ不足または allocation class 系のエラーで失敗した場合、拡張はワーカー 1 件、ソース 1 ファイル単位のセーフモードで再試行します。セーフ再試行では `.vscode/vc6-impact-review/native-diagnostics/` にファイル別 RSS 進捗を書き、失敗原因として特定したファイルだけをスキップし、インデックス作成診断に記録します。`maxRustAutoSkippedFiles` に達するまで継続し、`0` を設定するとメモリエラーを常にハードフェイルにできます。

`rustSidecarTimeoutMs` は Rust サイドカープロセスのタイムアウトだけを制御します。`-1` は自動タイムアウトを維持し、`0` はタイムアウトを無効化し、正の値は固定ミリ秒タイムアウトとして使います。

## 既知の制限

- 影響グラフとリスク表示はレビュー候補の可視化であり、安全性やリアルタイム順序を断定するものではありません。
- `threadMapFile` を設定しない場合、スレッド文脈の精度はインデックスから推定できる範囲に限られます。
- clang エンジンは診断収集用のフォールバックであり、JSON インデックスの抽出は TypeScript 経路を使います。
- Rust サイドカーがない状態で `parserEngine` を `rust` にすると、インデックス作成は明示的に失敗します。
- 生成レポートはシンボル単位で上書きされます。必要に応じて出力先の成果物を別名で退避してください。

## トラブルシューティング

- コマンドが見つからない場合は、VSIX の再インストール後に `Developer: Reload Window` を実行してください。
- `.dsw` または `.dsp` が自動検出されない場合は、`vc6Impact.projectFile` に明示パスを設定してください。
- 文字化けや読み取り失敗が起きる場合は、`vc6Impact.projectEncoding` または `vc6Impact.sourceEncoding` を `cp932` や `utf8` に固定してください。
- Rust 解析がメモリ不足で失敗する場合は、`vc6Impact.maxNativeBatchFiles` を `1` に下げるか、`vc6Impact.maxRustAutoSkippedFiles` の診断を確認してください。
- 呼び出しグラフが大きすぎる場合は、`vc6Impact.maxGraphDepth` を下げて表示範囲を制限してください。

## 開発と検証

```powershell
cargo test --manifest-path native/vc6-impact-rust/Cargo.toml
cargo build --release --manifest-path native/vc6-impact-rust/Cargo.toml
npm run check
npm run bench:index -- large
npx @vscode/vsce package --allow-missing-repository
```

`npm run check` は Vitest と TypeScript コンパイルを実行します。VSIX の作成前は Rust サイドカーの release ビルドも実行してください。
