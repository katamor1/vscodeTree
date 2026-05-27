use encoding_rs::SHIFT_JIS;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::thread;
use std::time::Instant;
use std::time::UNIX_EPOCH;
use sysinfo::System;
use tree_sitter::Parser;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileSignature {
    size: u64,
    mtime_ms: f64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceLocation {
    file: String,
    line: usize,
    text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GlobalVariable {
    name: String,
    file: String,
    line: usize,
    declaration: String,
    is_extern: bool,
    type_name: Option<String>,
    is_array: Option<bool>,
    pointer_level: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MacroDefinition {
    name: String,
    replacement: String,
    file: String,
    line: usize,
    declaration: String,
    is_function_like: bool,
    is_object_like: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StructMemberInfo {
    name: String,
    type_name: Option<String>,
    file: String,
    line: usize,
    declaration: String,
    is_array: Option<bool>,
    pointer_level: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StructTypeInfo {
    name: String,
    aliases: Vec<String>,
    file: String,
    line: usize,
    declaration: String,
    members: Vec<StructMemberInfo>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BodyLine {
    line: usize,
    raw: String,
    masked: String,
    identifiers: Vec<String>,
    call_identifiers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FunctionStructure {
    name: String,
    file: String,
    start_line: usize,
    end_line: usize,
    signature: String,
    body_lines: Vec<BodyLine>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UnresolvedEvidence {
    kind: String,
    function_name: Option<String>,
    variable_name: Option<String>,
    location: SourceLocation,
    evidence: String,
    note: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileStructure {
    file: String,
    signature: FileSignature,
    globals: Vec<GlobalVariable>,
    struct_types: Vec<StructTypeInfo>,
    macro_definitions: Vec<MacroDefinition>,
    functions: Vec<FunctionStructure>,
    unresolved: Vec<UnresolvedEvidence>,
}

#[allow(dead_code)]
#[derive(Clone)]
struct FunctionSummary {
    name: String,
    start_line: usize,
    end_line: usize,
    signature: String,
}

#[allow(dead_code)]
#[derive(Clone)]
struct FileSummary {
    file: String,
    signature: FileSignature,
    globals: Vec<GlobalVariable>,
    struct_types: Vec<StructTypeInfo>,
    macro_definitions: Vec<MacroDefinition>,
    functions: Vec<FunctionSummary>,
    parameter_member_accesses: HashMap<String, Vec<ParameterMemberAccessTemplate>>,
    unresolved: Vec<UnresolvedEvidence>,
    decode_info: DecodeInfo,
}

#[derive(Clone)]
struct DecodeInfo {
    used_encoding: &'static str,
    lossy: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VariableAccess {
    variable_name: String,
    target_name: Option<String>,
    target_kind: Option<String>,
    function_name: String,
    kind: String,
    location: SourceLocation,
    evidence: String,
    reasons: Vec<String>,
    owner_name: Option<String>,
    member_name: Option<String>,
    access_expression: Option<String>,
    macro_names: Option<Vec<String>>,
    expanded_evidence: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FunctionInfo {
    name: String,
    file: String,
    start_line: usize,
    end_line: usize,
    signature: String,
    calls: Vec<String>,
    accesses: Vec<VariableAccess>,
    unresolved: Vec<UnresolvedEvidence>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileAnalysis {
    file: String,
    signature: FileSignature,
    globals: Vec<GlobalVariable>,
    struct_types: Vec<StructTypeInfo>,
    macro_definitions: Vec<MacroDefinition>,
    functions: Vec<FunctionInfo>,
    unresolved: Vec<UnresolvedEvidence>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParserDiagnostic {
    backend: String,
    file: Option<String>,
    severity: String,
    message: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnalysisResult {
    files: Vec<FileAnalysis>,
    diagnostics: Vec<ParserDiagnostic>,
    metrics: HashMap<String, u128>,
    worker_count: usize,
}

#[derive(Clone)]
struct AnalyzeOptions {
    workers: Option<usize>,
    tree_sitter_diagnostics: bool,
    output: Option<String>,
    batch_size: usize,
    legacy_in_memory: bool,
    encoding: SourceEncoding,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceEncoding {
    Auto,
    Utf8,
    Cp932,
}

struct NativeContext {
    global_names: HashSet<String>,
    function_name_map: HashMap<String, Vec<String>>,
    parameter_member_accesses: HashMap<String, Vec<ParameterMemberAccessTemplate>>,
    struct_types: HashMap<String, StructTypeInfo>,
    global_types: HashMap<String, GlobalTypeInfo>,
    known_type_names: Vec<String>,
    known_member_names: HashSet<String>,
    macro_aliases: HashMap<String, Vec<MacroAliasInfo>>,
}

#[derive(Clone)]
struct ParameterMemberAccessTemplate {
    parameter_index: usize,
    member_path: Vec<String>,
    kind: String,
    member_name: Option<String>,
}

#[derive(Clone)]
struct GlobalTypeInfo {
    global: GlobalVariable,
    type_info: StructTypeInfo,
}

#[derive(Clone)]
struct MacroAliasInfo {
    name: String,
    replacement: String,
}

#[derive(Clone)]
struct PointerAlias {
    owner_name: String,
    owner_type_name: String,
    is_array_owner: bool,
    pointer_owner: bool,
}

#[derive(Clone)]
struct LocalTypeInfo {
    type_name: String,
    pointer_level: usize,
}

struct MemberExpression {
    expression: String,
    owner_name: String,
    owner_indexed: bool,
    first_connector: String,
    connectors: Vec<String>,
    member_path: Vec<String>,
    start: usize,
    end: usize,
}

struct ResolvedMemberExpression {
    access_target_name: Option<String>,
    owner_name: Option<String>,
    member_name: Option<String>,
    unresolved_kind: Option<String>,
    unresolved_name: Option<String>,
    unresolved_note: String,
}

struct DirectCall {
    name: String,
    arguments: Vec<String>,
}

static DEFINE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*#\s*define\s+([A-Za-z_]\w*)(\s*\([^)]*\))?\s*(.*)$").unwrap()
});
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:struct|class)\s+([A-Za-z_]\w*)").unwrap());
static TYPEDEF_ALIAS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*?\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$").unwrap());
static MEMBER_DECLARATOR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(?::\s*\d+)?$").unwrap()
});
static FUNCTION_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([~A-Za-z_]\w*(?:::[~A-Za-z_]\w*)?)\s*\([^(){};]*\)\s*(?:const)?\s*$").unwrap()
});
static GLOBAL_DECLARATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:\*|\s|^)([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*$").unwrap());
static INLINE_ASM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(__asm|asm)\b").unwrap());
static FUNCTION_POINTER_CALL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\s*\*\s*[A-Za-z_]\w*\s*\)\s*\(").unwrap());
static FUNCTION_POINTER_TABLE_DECL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\(\s*\*\s*([A-Za-z_]\w*)\s*\[[^\]]*\]\s*\)\s*\([^;{}]*\)\s*=").unwrap()
});
static ADDRESS_OF_FUNCTION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&\s*([A-Za-z_]\w*)").unwrap());
static POINTER_WRITE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\s*[A-Za-z_]\w*\s*=").unwrap());

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() == 3 && args[1] == "scan-file" {
        let file = normalize_path(&args[2]);
        let structure = scan_file(&file, true, SourceEncoding::Auto)?;
        serde_json::to_writer(std::io::stdout().lock(), &structure)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if args.len() == 3 && args[1] == "scan-many" {
        let list_text = fs::read_to_string(&args[2]).map_err(|error| error.to_string())?;
        let files: Vec<String> =
            serde_json::from_str(&list_text).map_err(|error| error.to_string())?;
        let structures = scan_many(files, None, false, SourceEncoding::Auto)?;
        serde_json::to_writer(std::io::stdout().lock(), &structures)
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    if args.len() >= 3 && args[1] == "analyze-many" {
        let list_text = fs::read_to_string(&args[2]).map_err(|error| error.to_string())?;
        let files: Vec<String> =
            serde_json::from_str(&list_text).map_err(|error| error.to_string())?;
        let options = parse_analyze_options(&args[3..])?;
        if options.legacy_in_memory {
            let output = options.output.clone();
            let result = analyze_many_legacy(files, options)?;
            write_json_result(output.as_deref(), &result)?;
        } else {
            write_low_memory_result(files, options)?;
        }
        return Ok(());
    }
    Err("Usage: vc6-impact-rust scan-file <path> | scan-many <file-list-json> | analyze-many <file-list-json> --workers <n|auto> [--output <path>] [--batch-size <n>] [--encoding <auto|utf8|cp932>] [--legacy-in-memory] [--tree-sitter-diagnostics]".to_string())
}

fn parse_analyze_options(args: &[String]) -> Result<AnalyzeOptions, String> {
    let mut options = AnalyzeOptions {
        workers: None,
        tree_sitter_diagnostics: false,
        output: None,
        batch_size: 1,
        legacy_in_memory: false,
        encoding: SourceEncoding::Auto,
    };
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--workers" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--workers requires a value".to_string())?;
                options.workers = if value.eq_ignore_ascii_case("auto") || value == "0" {
                    None
                } else {
                    Some(
                        value
                            .parse::<usize>()
                            .map_err(|_| format!("invalid --workers value: {value}"))?
                            .max(1),
                    )
                };
                index += 2;
            }
            "--tree-sitter-diagnostics" => {
                options.tree_sitter_diagnostics = true;
                index += 1;
            }
            "--output" => {
                options.output = Some(
                    args.get(index + 1)
                        .ok_or_else(|| "--output requires a value".to_string())?
                        .clone(),
                );
                index += 2;
            }
            "--batch-size" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--batch-size requires a value".to_string())?;
                options.batch_size = value
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --batch-size value: {value}"))?
                    .max(1);
                index += 2;
            }
            "--encoding" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--encoding requires a value".to_string())?;
                options.encoding = parse_source_encoding(value)?;
                index += 2;
            }
            "--legacy-in-memory" => {
                options.legacy_in_memory = true;
                index += 1;
            }
            other => return Err(format!("unknown analyze-many option: {other}")),
        }
    }
    Ok(options)
}

fn parse_source_encoding(value: &str) -> Result<SourceEncoding, String> {
    match value.to_ascii_lowercase().as_str() {
        "auto" => Ok(SourceEncoding::Auto),
        "utf8" | "utf-8" => Ok(SourceEncoding::Utf8),
        "cp932" | "shift_jis" | "shift-jis" | "windows-31j" => Ok(SourceEncoding::Cp932),
        other => Err(format!("invalid --encoding value: {other}")),
    }
}

fn scan_many(
    files: Vec<String>,
    requested_workers: Option<usize>,
    tree_sitter_diagnostics: bool,
    encoding: SourceEncoding,
) -> Result<Vec<FileStructure>, String> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let worker_count = effective_worker_count(files.len(), requested_workers);
    let mut chunks: Vec<Vec<(usize, String)>> = vec![Vec::new(); worker_count];
    for (index, file) in files.into_iter().enumerate() {
        chunks[index % worker_count].push((index, file));
    }
    let handles: Vec<_> = chunks
        .into_iter()
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            thread::spawn(move || -> Result<Vec<(usize, FileStructure)>, String> {
                let mut results = Vec::with_capacity(chunk.len());
                for (index, file) in chunk {
                    results.push((
                        index,
                        scan_file(&normalize_path(&file), tree_sitter_diagnostics, encoding)?,
                    ));
                }
                Ok(results)
            })
        })
        .collect();
    let mut indexed = Vec::new();
    for handle in handles {
        indexed.extend(
            handle
                .join()
                .map_err(|_| "rust sidecar worker panicked".to_string())??,
        );
    }
    indexed.sort_by_key(|(index, _)| *index);
    Ok(indexed
        .into_iter()
        .map(|(_, structure)| structure)
        .collect())
}

fn scan_many_summaries(
    files: Vec<String>,
    requested_workers: Option<usize>,
    tree_sitter_diagnostics: bool,
    encoding: SourceEncoding,
) -> Result<Vec<FileSummary>, String> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let worker_count = effective_worker_count(files.len(), requested_workers);
    let mut chunks: Vec<Vec<(usize, String)>> = vec![Vec::new(); worker_count];
    for (index, file) in files.into_iter().enumerate() {
        chunks[index % worker_count].push((index, file));
    }
    let handles: Vec<_> = chunks
        .into_iter()
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            thread::spawn(move || -> Result<Vec<(usize, FileSummary)>, String> {
                let mut results = Vec::with_capacity(chunk.len());
                for (index, file) in chunk {
                    results.push((
                        index,
                        scan_file_summary(
                            &normalize_path(&file),
                            tree_sitter_diagnostics,
                            encoding,
                        )?,
                    ));
                }
                Ok(results)
            })
        })
        .collect();
    let mut indexed = Vec::new();
    for handle in handles {
        indexed.extend(
            handle
                .join()
                .map_err(|_| "rust sidecar summary worker panicked".to_string())??,
        );
    }
    indexed.sort_by_key(|(index, _)| *index);
    Ok(indexed.into_iter().map(|(_, summary)| summary).collect())
}

fn effective_worker_count(file_count: usize, requested_workers: Option<usize>) -> usize {
    if file_count == 0 {
        return 1;
    }
    requested_workers
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(|count| count.get().saturating_sub(1).max(1))
                .unwrap_or(1)
        })
        .max(1)
        .min(file_count)
}

fn current_rss_bytes() -> Option<u128> {
    let pid = sysinfo::get_current_pid().ok()?;
    let mut system = System::new();
    system.refresh_process(pid);
    system.process(pid).map(|process| process.memory() as u128)
}

fn analyze_many_legacy(
    files: Vec<String>,
    options: AnalyzeOptions,
) -> Result<NativeAnalysisResult, String> {
    let total_started = Instant::now();
    let worker_count = effective_worker_count(files.len(), options.workers);
    let mut metrics = HashMap::new();
    let scan_started = Instant::now();
    let structures = scan_many(
        files,
        Some(worker_count),
        options.tree_sitter_diagnostics,
        options.encoding,
    )?;
    metrics.insert(
        "readMaskDeclarationScan".to_string(),
        scan_started.elapsed().as_millis(),
    );

    let symbol_started = Instant::now();
    let context = build_native_context(&structures);
    metrics.insert(
        "symbolMap".to_string(),
        symbol_started.elapsed().as_millis(),
    );

    let access_started = Instant::now();
    let files = analyze_structures(structures, &context, worker_count)?;
    metrics.insert(
        "accessAnalysis".to_string(),
        access_started.elapsed().as_millis(),
    );
    metrics.insert(
        "totalNative".to_string(),
        total_started.elapsed().as_millis(),
    );

    Ok(NativeAnalysisResult {
        files,
        diagnostics: vec![ParserDiagnostic {
            backend: "rust".to_string(),
            file: None,
            severity: "info".to_string(),
            message: format!(
                "legacy in-memory analyze-many completed with {worker_count} worker(s)"
            ),
        }],
        metrics,
        worker_count,
    })
}

fn write_json_result<T: Serialize>(output: Option<&str>, result: &T) -> Result<(), String> {
    if let Some(output_path) = output {
        write_atomic_json_output(output_path, |writer| {
            serde_json::to_writer(writer, result).map_err(|error| error.to_string())
        })?;
    } else {
        serde_json::to_writer(io::stdout().lock(), result).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_low_memory_result(files: Vec<String>, options: AnalyzeOptions) -> Result<(), String> {
    if let Some(output_path) = options.output.clone() {
        write_atomic_json_output(&output_path, |writer| {
            analyze_many_low_memory_to_writer(files, options, writer)
        })?;
    } else {
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        analyze_many_low_memory_to_writer(files, options, &mut writer)?;
    }
    Ok(())
}

fn write_atomic_json_output<F>(output_path: &str, write_fn: F) -> Result<(), String>
where
    F: FnOnce(&mut io::BufWriter<File>) -> Result<(), String>,
{
    let temp_path = atomic_temp_output_path(output_path);
    let file = File::create(&temp_path).map_err(|error| error.to_string())?;
    let mut writer = io::BufWriter::new(file);
    let write_result = write_fn(&mut writer);
    let flush_result = writer.flush().map_err(|error| error.to_string());
    drop(writer);

    if let Err(error) = write_result.and(flush_result) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if Path::new(output_path).exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temp_path, output_path).map_err(|error| error.to_string())?;
    Ok(())
}

fn atomic_temp_output_path(output_path: &str) -> String {
    let suffix = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{output_path}.tmp-{}-{suffix}", std::process::id())
}

fn analyze_many_low_memory_to_writer<W: Write>(
    files: Vec<String>,
    options: AnalyzeOptions,
    writer: &mut W,
) -> Result<(), String> {
    let total_started = Instant::now();
    let worker_count = effective_worker_count(files.len(), options.workers);
    let batch_size = options.batch_size.max(1);
    let mut metrics: HashMap<String, u128> = HashMap::new();
    metrics.insert("fileCount".to_string(), files.len() as u128);
    metrics.insert("workerCount".to_string(), worker_count as u128);
    metrics.insert("batchSize".to_string(), batch_size as u128);
    let mut peak_rss = current_rss_bytes().unwrap_or(0);

    let scan_started = Instant::now();
    let summaries = scan_many_summaries(
        files.clone(),
        Some(worker_count),
        options.tree_sitter_diagnostics,
        options.encoding,
    )?;
    peak_rss = peak_rss.max(current_rss_bytes().unwrap_or(0));
    metrics.insert(
        "readMaskDeclarationScan".to_string(),
        scan_started.elapsed().as_millis(),
    );

    let symbol_started = Instant::now();
    let context = build_native_context_from_summaries(&summaries);
    peak_rss = peak_rss.max(current_rss_bytes().unwrap_or(0));
    metrics.insert(
        "symbolMap".to_string(),
        symbol_started.elapsed().as_millis(),
    );

    let mut diagnostics = encoding_diagnostics(&summaries);
    diagnostics.insert(0, ParserDiagnostic {
        backend: "rust".to_string(),
        file: None,
        severity: "info".to_string(),
        message: format!("low-memory analyze-many completed with {worker_count} worker(s), batch size {batch_size}"),
    });

    let access_started = Instant::now();
    let mut counting = CountingWriter::new(writer);
    counting
        .write_all(b"{\"files\":[")
        .map_err(|error| error.to_string())?;
    let mut first_file = true;
    let mut streamed_file_count = 0usize;
    let mut max_structure_batch_files = 0usize;
    for batch in files.chunks(batch_size) {
        let analyses = analyze_file_batch_streaming(batch, &context, &options, worker_count)?;
        max_structure_batch_files = max_structure_batch_files.max(analyses.len());
        for analysis in analyses {
            if !first_file {
                counting
                    .write_all(b",")
                    .map_err(|error| error.to_string())?;
            }
            serde_json::to_writer(&mut counting, &analysis).map_err(|error| error.to_string())?;
            first_file = false;
            streamed_file_count += 1;
        }
        peak_rss = peak_rss.max(current_rss_bytes().unwrap_or(0));
    }
    metrics.insert(
        "accessAnalysis".to_string(),
        access_started.elapsed().as_millis(),
    );
    metrics.insert(
        "totalNative".to_string(),
        total_started.elapsed().as_millis(),
    );
    metrics.insert("streamedFileCount".to_string(), streamed_file_count as u128);
    metrics.insert(
        "maxStructureBatchFiles".to_string(),
        max_structure_batch_files as u128,
    );
    metrics.insert("peakRssBytes".to_string(), peak_rss);
    metrics.insert("outputBytes".to_string(), counting.bytes_written() as u128);

    counting
        .write_all(b"],\"diagnostics\":")
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut counting, &diagnostics).map_err(|error| error.to_string())?;
    counting
        .write_all(b",\"metrics\":")
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut counting, &metrics).map_err(|error| error.to_string())?;
    counting
        .write_all(format!(",\"workerCount\":{worker_count}}}").as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn analyze_file_batch_streaming(
    batch: &[String],
    context: &NativeContext,
    options: &AnalyzeOptions,
    worker_count: usize,
) -> Result<Vec<FileAnalysis>, String> {
    if batch.is_empty() {
        return Ok(Vec::new());
    }
    let batch_worker_count = worker_count.max(1).min(batch.len());
    let mut chunks: Vec<Vec<(usize, String)>> = vec![Vec::new(); batch_worker_count];
    for (index, file) in batch.iter().enumerate() {
        chunks[index % batch_worker_count].push((index, file.clone()));
    }
    let tree_sitter_diagnostics = options.tree_sitter_diagnostics;
    let encoding = options.encoding;

    thread::scope(|scope| -> Result<Vec<FileAnalysis>, String> {
        let handles: Vec<_> = chunks
            .into_iter()
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| {
                scope.spawn(move || -> Result<Vec<(usize, FileAnalysis)>, String> {
                    let mut results = Vec::with_capacity(chunk.len());
                    for (index, file) in chunk {
                        let structure =
                            scan_file(&normalize_path(&file), tree_sitter_diagnostics, encoding)?;
                        results.push((index, analyze_file_structure_native(structure, context)));
                    }
                    Ok(results)
                })
            })
            .collect();
        let mut indexed = Vec::with_capacity(batch.len());
        for handle in handles {
            indexed.extend(
                handle
                    .join()
                    .map_err(|_| "rust native bounded streaming worker panicked".to_string())??,
            );
        }
        indexed.sort_by_key(|(index, _)| *index);
        Ok(indexed.into_iter().map(|(_, analysis)| analysis).collect())
    })
}

struct CountingWriter<'a, W: Write> {
    inner: &'a mut W,
    bytes_written: usize,
}

impl<'a, W: Write> CountingWriter<'a, W> {
    fn new(inner: &'a mut W) -> Self {
        Self {
            inner,
            bytes_written: 0,
        }
    }

    fn bytes_written(&self) -> usize {
        self.bytes_written
    }
}

impl<W: Write> Write for CountingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.bytes_written += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn analyze_structures(
    structures: Vec<FileStructure>,
    context: &NativeContext,
    worker_count: usize,
) -> Result<Vec<FileAnalysis>, String> {
    if structures.is_empty() {
        return Ok(Vec::new());
    }
    let mut chunks: Vec<Vec<(usize, FileStructure)>> =
        vec![Vec::new(); worker_count.max(1).min(structures.len())];
    for (index, structure) in structures.into_iter().enumerate() {
        let target = index % chunks.len();
        chunks[target].push((index, structure));
    }
    thread::scope(|scope| -> Result<Vec<FileAnalysis>, String> {
        let handles: Vec<_> = chunks
            .into_iter()
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| {
                scope.spawn(move || -> Vec<(usize, FileAnalysis)> {
                    chunk
                        .into_iter()
                        .map(|(index, structure)| {
                            (index, analyze_file_structure_native(structure, context))
                        })
                        .collect()
                })
            })
            .collect();
        let mut indexed = Vec::new();
        for handle in handles {
            indexed.extend(
                handle
                    .join()
                    .map_err(|_| "rust native analysis worker panicked".to_string())?,
            );
        }
        indexed.sort_by_key(|(index, _)| *index);
        Ok(indexed.into_iter().map(|(_, file)| file).collect())
    })
}

fn build_native_context(files: &[FileStructure]) -> NativeContext {
    let mut global_names = HashSet::new();
    let mut function_name_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut struct_types: HashMap<String, StructTypeInfo> = HashMap::new();
    let mut known_member_names = HashSet::new();

    for file in files {
        for global in &file.globals {
            global_names.insert(global.name.clone());
        }
        for func in &file.functions {
            function_name_map
                .entry(simplify_function_name(&func.name))
                .or_default()
                .push(func.name.clone());
        }
        for struct_type in &file.struct_types {
            for type_name in std::iter::once(&struct_type.name).chain(struct_type.aliases.iter()) {
                if !type_name.is_empty() && !struct_types.contains_key(type_name) {
                    struct_types.insert(type_name.clone(), struct_type.clone());
                }
            }
            for member in &struct_type.members {
                known_member_names.insert(member.name.clone());
            }
        }
    }
    for names in function_name_map.values_mut() {
        names.sort();
    }

    let mut global_types = HashMap::new();
    for file in files {
        for global in &file.globals {
            if let Some(type_name) = &global.type_name {
                if let Some(type_info) = struct_types.get(type_name) {
                    global_types.insert(
                        global.name.clone(),
                        GlobalTypeInfo {
                            global: global.clone(),
                            type_info: type_info.clone(),
                        },
                    );
                }
            }
        }
    }

    let mut macro_aliases: HashMap<String, Vec<MacroAliasInfo>> = HashMap::new();
    let member_symbols = build_member_symbol_names(&global_types, &struct_types);
    for file in files {
        for definition in &file.macro_definitions {
            if let Some(alias) =
                resolve_macro_alias_native(definition, &global_names, &member_symbols)
            {
                macro_aliases
                    .entry(alias.name.clone())
                    .or_default()
                    .push(alias);
            }
        }
    }

    let mut known_type_names: Vec<String> = struct_types.keys().cloned().collect();
    known_type_names.sort_by(|left, right| right.len().cmp(&left.len()).then(left.cmp(right)));

    let mut context = NativeContext {
        global_names,
        function_name_map,
        parameter_member_accesses: HashMap::new(),
        struct_types,
        global_types,
        known_type_names,
        known_member_names,
        macro_aliases,
    };
    context.parameter_member_accesses =
        build_parameter_member_access_templates_from_structures(files);
    context
}

fn build_native_context_from_summaries(files: &[FileSummary]) -> NativeContext {
    let mut global_names = HashSet::new();
    let mut function_name_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut struct_types: HashMap<String, StructTypeInfo> = HashMap::new();
    let mut known_member_names = HashSet::new();

    for file in files {
        for global in &file.globals {
            global_names.insert(global.name.clone());
        }
        for func in &file.functions {
            function_name_map
                .entry(simplify_function_name(&func.name))
                .or_default()
                .push(func.name.clone());
        }
        for struct_type in &file.struct_types {
            for type_name in std::iter::once(&struct_type.name).chain(struct_type.aliases.iter()) {
                if !type_name.is_empty() && !struct_types.contains_key(type_name) {
                    struct_types.insert(type_name.clone(), struct_type.clone());
                }
            }
            for member in &struct_type.members {
                known_member_names.insert(member.name.clone());
            }
        }
    }
    for names in function_name_map.values_mut() {
        names.sort();
    }
    let mut parameter_member_accesses: HashMap<String, Vec<ParameterMemberAccessTemplate>> =
        HashMap::new();
    for file in files {
        for (function_name, templates) in &file.parameter_member_accesses {
            parameter_member_accesses
                .entry(function_name.clone())
                .or_insert_with(|| templates.clone());
        }
    }

    let mut global_types = HashMap::new();
    for file in files {
        for global in &file.globals {
            if let Some(type_name) = &global.type_name {
                if let Some(type_info) = struct_types.get(type_name) {
                    global_types.insert(
                        global.name.clone(),
                        GlobalTypeInfo {
                            global: global.clone(),
                            type_info: type_info.clone(),
                        },
                    );
                }
            }
        }
    }

    let mut macro_aliases: HashMap<String, Vec<MacroAliasInfo>> = HashMap::new();
    let member_symbols = build_member_symbol_names(&global_types, &struct_types);
    for file in files {
        for definition in &file.macro_definitions {
            if let Some(alias) =
                resolve_macro_alias_native(definition, &global_names, &member_symbols)
            {
                macro_aliases
                    .entry(alias.name.clone())
                    .or_default()
                    .push(alias);
            }
        }
    }

    let mut known_type_names: Vec<String> = struct_types.keys().cloned().collect();
    known_type_names.sort_by(|left, right| right.len().cmp(&left.len()).then(left.cmp(right)));

    NativeContext {
        global_names,
        function_name_map,
        parameter_member_accesses,
        struct_types,
        global_types,
        known_type_names,
        known_member_names,
        macro_aliases,
    }
}

fn build_parameter_member_access_templates_from_structures(
    files: &[FileStructure],
) -> HashMap<String, Vec<ParameterMemberAccessTemplate>> {
    let mut templates = HashMap::new();
    for file in files {
        let file_templates =
            build_parameter_member_access_templates_from_functions(&file.functions);
        for (function_name, items) in file_templates {
            templates.entry(function_name).or_insert(items);
        }
    }
    templates
}

fn build_parameter_member_access_templates_from_functions(
    functions: &[FunctionStructure],
) -> HashMap<String, Vec<ParameterMemberAccessTemplate>> {
    let mut result = HashMap::new();
    for function in functions {
        let parameter_names = parameter_names_from_signature(&function.signature);
        if parameter_names.is_empty() {
            continue;
        }
        let parameter_index_by_name: HashMap<String, usize> = parameter_names
            .iter()
            .enumerate()
            .map(|(index, name)| (name.clone(), index))
            .collect();
        let mut function_templates = Vec::new();
        let mut seen_templates = HashSet::new();
        for body_line in &function.body_lines {
            collect_parameter_member_access_templates(
                &body_line.masked,
                &parameter_index_by_name,
                &mut function_templates,
                &mut seen_templates,
            );
        }
        if !function_templates.is_empty() {
            result.insert(function.name.clone(), function_templates);
        }
    }
    result
}

fn collect_parameter_member_access_templates(
    masked: &str,
    parameter_index_by_name: &HashMap<String, usize>,
    templates: &mut Vec<ParameterMemberAccessTemplate>,
    seen_templates: &mut HashSet<String>,
) {
    if parameter_index_by_name.is_empty() {
        return;
    }
    for expression in extract_member_expressions(masked) {
        let Some(parameter_index) = parameter_index_by_name.get(&expression.owner_name).copied()
        else {
            continue;
        };
        let (kind, _) = classify_access(masked, &expression.expression);
        let member_path = expression.member_path.clone();
        let key = format!("{}:{}:{}", parameter_index, member_path.join("."), kind);
        if !seen_templates.insert(key) {
            continue;
        }
        templates.push(ParameterMemberAccessTemplate {
            parameter_index,
            member_path,
            kind,
            member_name: expression.member_path.last().cloned(),
        });
    }
}

fn parameter_names_from_signature(signature: &str) -> Vec<String> {
    let Some(start) = signature.find('(') else {
        return Vec::new();
    };
    let Some(end) = signature.rfind(')') else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let params = signature[start + 1..end].trim();
    if params.is_empty() || params == "void" {
        return Vec::new();
    }
    split_top_level_commas(params)
        .into_iter()
        .filter_map(|param| {
            let declarator = param.split('=').next().unwrap_or("").trim();
            identifiers(declarator)
                .into_iter()
                .filter(|name| {
                    !is_keyword(name)
                        && !matches!(name.as_str(), "const" | "volatile" | "register" | "static")
                })
                .last()
        })
        .collect()
}

fn encoding_diagnostics(summaries: &[FileSummary]) -> Vec<ParserDiagnostic> {
    let mut counts: HashMap<&'static str, usize> = HashMap::new();
    let mut lossy_files = Vec::new();
    for summary in summaries {
        *counts.entry(summary.decode_info.used_encoding).or_insert(0) += 1;
        if summary.decode_info.lossy {
            lossy_files.push(summary.file.clone());
        }
    }
    let mut keys: Vec<_> = counts.keys().copied().collect();
    keys.sort();
    let usage = keys
        .into_iter()
        .map(|key| format!("{key}={}", counts.get(key).copied().unwrap_or(0)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut diagnostics = vec![ParserDiagnostic {
        backend: "rust".to_string(),
        file: None,
        severity: "info".to_string(),
        message: format!(
            "source encoding usage: {usage}; lossy={}",
            lossy_files.len()
        ),
    }];
    if let Some(first_lossy) = lossy_files.first() {
        diagnostics.push(ParserDiagnostic {
            backend: "rust".to_string(),
            file: Some(first_lossy.clone()),
            severity: "warning".to_string(),
            message: format!(
                "{} source file(s) required lossy CP932 decoding",
                lossy_files.len()
            ),
        });
    }
    diagnostics
}

fn build_member_symbol_names(
    global_types: &HashMap<String, GlobalTypeInfo>,
    struct_types: &HashMap<String, StructTypeInfo>,
) -> HashSet<String> {
    let mut symbols = HashSet::new();
    for global_type in global_types.values() {
        let owner_name = if global_type.global.is_array.unwrap_or(false) {
            format!("{}[]", global_type.global.name)
        } else {
            global_type.global.name.clone()
        };
        let separator = if global_type.global.pointer_level.unwrap_or(0) > 0 {
            "->"
        } else {
            "."
        };
        append_member_symbol_names(
            &mut symbols,
            &owner_name,
            separator,
            "",
            &global_type.type_info,
            struct_types,
            0,
        );
        if global_type.global.pointer_level.unwrap_or(0) > 0
            && !global_type.global.is_array.unwrap_or(false)
        {
            append_member_symbol_names(
                &mut symbols,
                &format!("{}[]", global_type.global.name),
                "->",
                "",
                &global_type.type_info,
                struct_types,
                0,
            );
        }
    }
    symbols
}

fn append_member_symbol_names(
    symbols: &mut HashSet<String>,
    owner_name: &str,
    separator: &str,
    path_prefix: &str,
    type_info: &StructTypeInfo,
    struct_types: &HashMap<String, StructTypeInfo>,
    depth: usize,
) {
    if depth > 2 {
        return;
    }
    for member in &type_info.members {
        let member_path = if path_prefix.is_empty() {
            member.name.clone()
        } else {
            format!("{path_prefix}.{}", member.name)
        };
        symbols.insert(format!("{owner_name}{separator}{member_path}"));
        if member.pointer_level.unwrap_or(0) == 0 {
            if let Some(nested_type) = member
                .type_name
                .as_ref()
                .and_then(|type_name| struct_types.get(type_name))
            {
                append_member_symbol_names(
                    symbols,
                    owner_name,
                    separator,
                    &member_path,
                    nested_type,
                    struct_types,
                    depth + 1,
                );
            }
        }
    }
}

fn resolve_macro_alias_native(
    definition: &MacroDefinition,
    global_names: &HashSet<String>,
    member_symbols: &HashSet<String>,
) -> Option<MacroAliasInfo> {
    if definition.is_function_like
        || definition.replacement.is_empty()
        || is_header_guard_macro(definition)
    {
        return None;
    }
    let replacement = definition.replacement.trim();
    if !is_simple_macro_replacement(replacement) {
        return None;
    }
    if !global_names.contains(replacement)
        && !member_symbols.contains(replacement)
        && replacement
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    Some(MacroAliasInfo {
        name: definition.name.clone(),
        replacement: replacement.to_string(),
    })
}

fn analyze_file_structure_native(
    structure: FileStructure,
    context: &NativeContext,
) -> FileAnalysis {
    let functions = structure
        .functions
        .iter()
        .map(|func| analyze_function_native(func, context))
        .collect();
    FileAnalysis {
        file: structure.file,
        signature: structure.signature,
        globals: structure.globals,
        struct_types: structure.struct_types,
        macro_definitions: structure.macro_definitions,
        functions,
        unresolved: structure.unresolved,
    }
}

fn analyze_function_native(func: &FunctionStructure, context: &NativeContext) -> FunctionInfo {
    let mut accesses = Vec::new();
    let mut access_keys = HashSet::new();
    let mut unresolved = Vec::new();
    let mut calls = HashSet::new();
    let mut local_types = parse_function_parameter_types(&func.signature, context);
    let mut pointer_aliases: HashMap<String, PointerAlias> = HashMap::new();
    let mut ambiguous_aliases: HashSet<String> = HashSet::new();
    let function_pointer_tables = local_function_pointer_tables(func, context);

    for body_line in &func.body_lines {
        let expansion = expand_macro_line(&body_line.masked, context);
        let masked = expansion.0;
        let macro_names = expansion.1;
        let raw = &body_line.raw;
        register_local_types_and_aliases(
            &masked,
            context,
            &mut local_types,
            &mut pointer_aliases,
            &mut ambiguous_aliases,
        );
        let member_expressions = extract_member_expressions(&masked);
        let masked_without_members = mask_ranges(&masked, &member_expressions);

        if INLINE_ASM_RE.is_match(&masked) {
            unresolved.push(unresolved_evidence(
                "inline-asm",
                Some(&func.name),
                None,
                &func.file,
                body_line.line,
                raw,
                "inline assembly内のメモリアクセスは解析対象外です。",
            ));
        }
        if FUNCTION_POINTER_CALL_RE.is_match(&masked) {
            unresolved.push(unresolved_evidence(
                "function-pointer",
                Some(&func.name),
                None,
                &func.file,
                body_line.line,
                raw,
                "関数ポインタ呼び出しは呼び出し先を断定していません。",
            ));
        }
        if POINTER_WRITE_RE.is_match(&masked) {
            unresolved.push(unresolved_evidence(
                "pointer-write",
                Some(&func.name),
                None,
                &func.file,
                body_line.line,
                raw,
                "ポインタ経由の書き込みは別名先を断定していません。",
            ));
        }

        for expression in &member_expressions {
            let Some(resolved) = resolve_member_expression(
                expression,
                context,
                &local_types,
                &pointer_aliases,
                &ambiguous_aliases,
            ) else {
                continue;
            };
            let (kind, reasons) = classify_access(&masked, &expression.expression);
            if let Some(target_name) = &resolved.access_target_name {
                push_access_once(
                    &mut accesses,
                    &mut access_keys,
                    VariableAccess {
                        variable_name: target_name.clone(),
                        target_name: Some(target_name.clone()),
                        target_kind: Some("member".to_string()),
                        function_name: func.name.clone(),
                        kind,
                        location: location(&func.file, body_line.line, raw),
                        evidence: raw.trim().to_string(),
                        expanded_evidence: expanded_evidence(raw, &masked),
                        reasons: reasons.clone(),
                        owner_name: resolved.owner_name.clone(),
                        member_name: resolved.member_name.clone(),
                        access_expression: Some(expression.expression.clone()),
                        macro_names: macro_names_option(&macro_names),
                    },
                );
            }
            if reasons.iter().any(|reason| reason == "address-taken") {
                if let Some(target_name) = &resolved.access_target_name {
                    unresolved.push(unresolved_evidence(
                        "address-taken",
                        Some(&func.name),
                        Some(target_name),
                        &func.file,
                        body_line.line,
                        raw,
                        "構造体メンバのアドレス取得があり、以降の別名更新は断定していません。",
                    ));
                }
            }
            if let Some(kind) = &resolved.unresolved_kind {
                unresolved.push(unresolved_evidence(
                    kind,
                    Some(&func.name),
                    resolved.unresolved_name.as_deref(),
                    &func.file,
                    body_line.line,
                    raw,
                    &resolved.unresolved_note,
                ));
            }
        }

        for variable_name in identifiers(&masked) {
            if !context.global_names.contains(&variable_name)
                || !contains_word(&masked_without_members, &variable_name)
            {
                continue;
            }
            let (kind, reasons) = classify_access(&masked_without_members, &variable_name);
            push_access_once(
                &mut accesses,
                &mut access_keys,
                VariableAccess {
                    variable_name: variable_name.clone(),
                    target_name: Some(variable_name.clone()),
                    target_kind: Some("global".to_string()),
                    function_name: func.name.clone(),
                    kind,
                    location: location(&func.file, body_line.line, raw),
                    evidence: raw.trim().to_string(),
                    expanded_evidence: expanded_evidence(raw, &masked),
                    reasons: reasons.clone(),
                    owner_name: None,
                    member_name: None,
                    access_expression: None,
                    macro_names: macro_names_option(&macro_names),
                },
            );
            if reasons.iter().any(|reason| reason == "address-taken") {
                unresolved.push(unresolved_evidence(
                    "address-taken",
                    Some(&func.name),
                    Some(&variable_name),
                    &func.file,
                    body_line.line,
                    raw,
                    "グローバル変数のアドレス取得があり、以降の別名更新は断定していません。",
                ));
            }
        }

        for direct_call in direct_calls(&masked) {
            let Some(functions) = context.function_name_map.get(&direct_call.name) else {
                continue;
            };
            for function_name in functions {
                if function_name == &func.name {
                    continue;
                }
                let Some(templates) = context.parameter_member_accesses.get(function_name) else {
                    continue;
                };
                for template in templates {
                    let Some(argument) = direct_call.arguments.get(template.parameter_index) else {
                        continue;
                    };
                    let Some((owner_name, first_connector)) = resolve_call_argument_owner(
                        argument,
                        context,
                        &local_types,
                        &pointer_aliases,
                        &ambiguous_aliases,
                    ) else {
                        continue;
                    };
                    let target_name =
                        append_member_path(&owner_name, &first_connector, &template.member_path);
                    push_access_once(
                        &mut accesses,
                        &mut access_keys,
                        VariableAccess {
                            variable_name: target_name.clone(),
                            target_name: Some(target_name.clone()),
                            target_kind: Some("member".to_string()),
                            function_name: func.name.clone(),
                            kind: template.kind.clone(),
                            location: location(&func.file, body_line.line, raw),
                            evidence: raw.trim().to_string(),
                            expanded_evidence: expanded_evidence(raw, &masked),
                            reasons: vec!["call-argument-alias".to_string()],
                            owner_name: Some(owner_name),
                            member_name: template.member_name.clone(),
                            access_expression: Some(argument.trim().to_string()),
                            macro_names: macro_names_option(&macro_names),
                        },
                    );
                }
            }
        }

        for simple_name in call_identifiers(&masked) {
            if let Some(functions) = context.function_name_map.get(&simple_name) {
                for function_name in functions {
                    if function_name != &func.name {
                        calls.insert(function_name.clone());
                    }
                }
            }
        }
        for function_name in function_pointer_table_call_targets(&masked, &function_pointer_tables)
        {
            if function_name != func.name {
                calls.insert(function_name);
            }
        }
    }

    let mut calls: Vec<String> = calls.into_iter().collect();
    calls.sort();
    FunctionInfo {
        name: func.name.clone(),
        file: func.file.clone(),
        start_line: func.start_line,
        end_line: func.end_line,
        signature: func.signature.clone(),
        calls,
        accesses,
        unresolved,
    }
}

fn push_access_once(
    accesses: &mut Vec<VariableAccess>,
    seen: &mut HashSet<String>,
    access: VariableAccess,
) {
    let line = access.location.line.to_string();
    let macro_names = access
        .macro_names
        .as_ref()
        .map(|names| names.join(","))
        .unwrap_or_default();
    let reasons = access.reasons.join(",");
    let key = [
        access.target_kind.as_deref().unwrap_or(""),
        access
            .target_name
            .as_deref()
            .unwrap_or(&access.variable_name),
        access.kind.as_str(),
        access.location.file.as_str(),
        line.as_str(),
        access.access_expression.as_deref().unwrap_or(""),
        reasons.as_str(),
        macro_names.as_str(),
    ]
    .join("\u{1f}");
    if seen.insert(key) {
        accesses.push(access);
    }
}

fn local_function_pointer_tables(
    func: &FunctionStructure,
    context: &NativeContext,
) -> HashMap<String, Vec<String>> {
    let mut result = HashMap::new();
    let mut active: Option<(String, Vec<String>)> = None;
    for body_line in &func.body_lines {
        let line = body_line.masked.as_str();
        if let Some((name, targets)) = active.as_mut() {
            targets.extend(addressed_known_functions(line, context));
            if line.contains(';') {
                let mut completed = Vec::new();
                std::mem::swap(targets, &mut completed);
                result.insert(name.clone(), unique(completed));
                active = None;
            }
            continue;
        }
        let Some(captures) = FUNCTION_POINTER_TABLE_DECL_RE.captures(line) else {
            continue;
        };
        let Some(name) = captures.get(1).map(|item| item.as_str().to_string()) else {
            continue;
        };
        let initializer = captures
            .get(0)
            .map(|item| &line[item.end()..])
            .unwrap_or("");
        let mut targets = addressed_known_functions(initializer, context);
        if initializer.contains(';') {
            result.insert(name, unique(targets));
        } else {
            active = Some((name, {
                let mut seed = Vec::new();
                std::mem::swap(&mut targets, &mut seed);
                seed
            }));
        }
    }
    result.retain(|_, targets| !targets.is_empty());
    result
}

fn addressed_known_functions(text: &str, context: &NativeContext) -> Vec<String> {
    let mut result = Vec::new();
    for captures in ADDRESS_OF_FUNCTION_RE.captures_iter(text) {
        let Some(simple_name) = captures.get(1).map(|item| item.as_str()) else {
            continue;
        };
        if let Some(functions) = context.function_name_map.get(simple_name) {
            result.extend(functions.iter().cloned());
        }
    }
    result
}

fn function_pointer_table_call_targets(
    line: &str,
    tables: &HashMap<String, Vec<String>>,
) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut result = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if !is_ident_start(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < bytes.len() && is_ident_continue(bytes[index]) {
            index += 1;
        }
        let name = &line[start..index];
        let Some(targets) = tables.get(name) else {
            continue;
        };
        let mut lookahead = index;
        skip_ascii_space(line, &mut lookahead);
        if lookahead >= bytes.len() || bytes[lookahead] != b'[' {
            continue;
        }
        let close_bracket = skip_bracket(line, lookahead);
        if close_bracket <= lookahead + 1 || close_bracket > line.len() {
            continue;
        }
        lookahead = close_bracket;
        skip_ascii_space(line, &mut lookahead);
        if lookahead < bytes.len() && bytes[lookahead] == b'(' {
            result.extend(targets.iter().cloned());
        }
    }
    unique(result)
}

fn is_header_guard_macro(definition: &MacroDefinition) -> bool {
    definition.replacement.is_empty()
        && (definition.name.ends_with("_H")
            || definition.name.contains("_H_")
            || definition.name.ends_with("_INCLUDED")
            || definition.name.contains("_INCLUDED_"))
}

fn is_simple_macro_replacement(value: &str) -> bool {
    let mut index = 0usize;
    if read_identifier(value, &mut index).is_none() {
        return false;
    }
    loop {
        skip_ascii_space(value, &mut index);
        if index >= value.len() {
            return true;
        }
        if value[index..].starts_with("::") {
            index += 2;
        } else if value[index..].starts_with("->") {
            index += 2;
        } else if value.as_bytes()[index] == b'.' {
            index += 1;
        } else {
            return false;
        }
        skip_ascii_space(value, &mut index);
        if read_identifier(value, &mut index).is_none() {
            return false;
        }
    }
}

fn expand_macro_line(line: &str, context: &NativeContext) -> (String, Vec<String>) {
    let mut expanded = line.to_string();
    let mut used = HashSet::new();
    let mut visiting = HashSet::new();
    for _ in 0..3 {
        let mut changed = false;
        for (name, aliases) in &context.macro_aliases {
            let Some(alias) = aliases.first() else {
                continue;
            };
            if visiting.contains(name) {
                continue;
            }
            let next = replace_word(&expanded, name, &alias.replacement);
            if next != expanded {
                visiting.insert(name.clone());
                expanded = next;
                used.insert(name.clone());
                changed = true;
                visiting.remove(name);
            }
        }
        if !changed {
            break;
        }
    }
    let mut used: Vec<String> = used.into_iter().collect();
    used.sort();
    (expanded, used)
}

fn replace_word(line: &str, word: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let bytes = line.as_bytes();
    let word_bytes = word.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if index + word_bytes.len() <= bytes.len()
            && &bytes[index..index + word_bytes.len()] == word_bytes
            && is_word_boundary(bytes, index)
            && is_word_boundary(bytes, index + word_bytes.len())
        {
            output.push_str(replacement);
            index += word_bytes.len();
        } else {
            output.push(bytes[index] as char);
            index += 1;
        }
    }
    output
}

fn parse_function_parameter_types(
    signature: &str,
    context: &NativeContext,
) -> HashMap<String, LocalTypeInfo> {
    let mut local_types = HashMap::new();
    let Some(start) = signature.find('(') else {
        return local_types;
    };
    let Some(end) = signature.rfind(')') else {
        return local_types;
    };
    if end <= start {
        return local_types;
    }
    let params = signature[start + 1..end].trim();
    if params.is_empty() || params == "void" {
        return local_types;
    }
    for param in split_top_level_commas(params) {
        if let Some(parsed) = parse_typed_declarator(&param, context) {
            local_types.insert(
                parsed.0,
                LocalTypeInfo {
                    type_name: parsed.1,
                    pointer_level: parsed.2,
                },
            );
        }
    }
    local_types
}

fn register_local_types_and_aliases(
    line: &str,
    context: &NativeContext,
    local_types: &mut HashMap<String, LocalTypeInfo>,
    pointer_aliases: &mut HashMap<String, PointerAlias>,
    ambiguous_aliases: &mut HashSet<String>,
) {
    for statement in line.split(';') {
        if let Some((name, type_name, pointer_level, initializer)) =
            parse_typed_declarator(statement, context)
        {
            local_types.insert(
                name.clone(),
                LocalTypeInfo {
                    type_name: type_name.clone(),
                    pointer_level,
                },
            );
            if pointer_level > 0 {
                if let Some(initializer) = initializer {
                    set_pointer_alias_from_initializer(
                        &name,
                        &initializer,
                        &type_name,
                        context,
                        pointer_aliases,
                        ambiguous_aliases,
                    );
                }
            }
        }
    }

    let snapshot: Vec<(String, LocalTypeInfo)> = local_types
        .iter()
        .map(|(name, info)| (name.clone(), info.clone()))
        .collect();
    for (name, local_type) in snapshot {
        if local_type.pointer_level == 0 {
            continue;
        }
        if let Some((assignment_index, initializer)) = find_simple_assignment(line, &name) {
            let prefix = &line[..assignment_index];
            if !prefix.contains(&local_type.type_name) {
                set_pointer_alias_from_initializer(
                    &name,
                    &initializer,
                    &local_type.type_name,
                    context,
                    pointer_aliases,
                    ambiguous_aliases,
                );
            }
        }
    }
}

fn parse_typed_declarator(
    text: &str,
    context: &NativeContext,
) -> Option<(String, String, usize, Option<String>)> {
    let before_semicolon = text.split(';').next().unwrap_or("").trim();
    if before_semicolon.is_empty() {
        return None;
    }
    for type_name in &context.known_type_names {
        let compact = before_semicolon.replace('\t', " ");
        let Some(type_pos) = find_word(&compact, type_name) else {
            continue;
        };
        let before = compact[..type_pos].trim();
        if !before.is_empty()
            && !before.split_whitespace().all(|token| {
                matches!(
                    token,
                    "const" | "volatile" | "static" | "register" | "struct" | "class"
                )
            })
        {
            continue;
        }
        let mut rest = compact[type_pos + type_name.len()..].trim();
        if rest.is_empty() {
            continue;
        }
        let initializer = rest.find('=').map(|eq| rest[eq + 1..].trim().to_string());
        if let Some(eq) = rest.find('=') {
            rest = rest[..eq].trim();
        }
        let pointer_level = rest.chars().filter(|ch| *ch == '*').count();
        let mut index = 0usize;
        while index < rest.len()
            && (rest.as_bytes()[index].is_ascii_whitespace()
                || rest.as_bytes()[index] == b'*'
                || rest.as_bytes()[index] == b'&')
        {
            index += 1;
        }
        if let Some(name) = read_identifier(rest, &mut index) {
            skip_ascii_space(rest, &mut index);
            if index < rest.len() && rest.as_bytes()[index] == b'[' {
                index = skip_bracket(rest, index);
            }
            skip_ascii_space(rest, &mut index);
            if index == rest.len() && !is_keyword(&name) {
                return Some((
                    name,
                    type_name.clone(),
                    pointer_level,
                    initializer.filter(|value| !value.is_empty()),
                ));
            }
        }
    }
    None
}

fn set_pointer_alias_from_initializer(
    pointer_name: &str,
    initializer: &str,
    expected_type_name: &str,
    context: &NativeContext,
    pointer_aliases: &mut HashMap<String, PointerAlias>,
    ambiguous_aliases: &mut HashSet<String>,
) {
    let Some(resolved) =
        resolve_pointer_initializer(initializer, expected_type_name, context, pointer_aliases)
    else {
        pointer_aliases.remove(pointer_name);
        ambiguous_aliases.insert(pointer_name.to_string());
        return;
    };
    if let Some(existing) = pointer_aliases.get(pointer_name) {
        if alias_key(existing) != alias_key(&resolved) {
            pointer_aliases.remove(pointer_name);
            ambiguous_aliases.insert(pointer_name.to_string());
            return;
        }
    }
    if !ambiguous_aliases.contains(pointer_name) {
        pointer_aliases.insert(pointer_name.to_string(), resolved);
    }
}

fn resolve_pointer_initializer(
    initializer: &str,
    expected_type_name: &str,
    context: &NativeContext,
    pointer_aliases: &HashMap<String, PointerAlias>,
) -> Option<PointerAlias> {
    let value = initializer.split_whitespace().collect::<Vec<_>>().join(" ");
    if matches!(value.as_str(), "0" | "NULL" | "nullptr") {
        return None;
    }
    if let Some(rest) = value.strip_prefix('&') {
        let trimmed = rest.trim();
        let mut index = 0usize;
        let name = read_identifier(trimmed, &mut index)?;
        let indexed = trimmed[index..].contains('[');
        if let Some(global_type) = context.global_types.get(&name) {
            if global_type.global.type_name.as_deref() == Some(expected_type_name) {
                return Some(PointerAlias {
                    owner_name: if global_type.global.is_array.unwrap_or(false) || indexed {
                        format!("{name}[]")
                    } else {
                        name
                    },
                    owner_type_name: global_type
                        .global
                        .type_name
                        .clone()
                        .unwrap_or_else(|| expected_type_name.to_string()),
                    is_array_owner: global_type.global.is_array.unwrap_or(false) || indexed,
                    pointer_owner: false,
                });
            }
        }
    }
    let mut index = 0usize;
    if let Some(source_name) = read_identifier(&value, &mut index) {
        skip_ascii_space(&value, &mut index);
        if index == value.len() {
            if let Some(copied) = pointer_aliases.get(&source_name) {
                return Some(copied.clone());
            }
            if let Some(global_type) = context.global_types.get(&source_name) {
                if global_type.global.pointer_level.unwrap_or(0) > 0
                    && global_type.global.type_name.as_deref() == Some(expected_type_name)
                {
                    return Some(PointerAlias {
                        owner_name: source_name,
                        owner_type_name: global_type
                            .global
                            .type_name
                            .clone()
                            .unwrap_or_else(|| expected_type_name.to_string()),
                        is_array_owner: false,
                        pointer_owner: true,
                    });
                }
            }
        }
    }
    None
}

fn extract_member_expressions(line: &str) -> Vec<MemberExpression> {
    let mut expressions = Vec::new();
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let start = index;
        let Some((owner, owner_start, mut owner_indexed)) = read_member_owner(line, &mut index)
        else {
            index += 1;
            continue;
        };
        skip_ascii_space(line, &mut index);
        if index < bytes.len() && bytes[index] == b'[' {
            owner_indexed = true;
            index = skip_bracket(line, index);
            skip_ascii_space(line, &mut index);
        }
        let first_connector = if line[index..].starts_with("->") {
            index += 2;
            "->"
        } else if index < bytes.len() && bytes[index] == b'.' {
            index += 1;
            "."
        } else {
            index = start + 1;
            continue;
        };
        let mut member_path = Vec::new();
        let mut connectors = Vec::new();
        let mut next_connector = first_connector.to_string();
        loop {
            skip_ascii_space(line, &mut index);
            let Some(member) = read_identifier(line, &mut index) else {
                break;
            };
            connectors.push(next_connector.clone());
            member_path.push(member);
            skip_ascii_space(line, &mut index);
            if index < bytes.len() && bytes[index] == b'[' {
                index = skip_bracket(line, index);
                skip_ascii_space(line, &mut index);
            }
            if line[index..].starts_with("->") {
                index += 2;
                next_connector = "->".to_string();
            } else if index < bytes.len() && bytes[index] == b'.' {
                index += 1;
                next_connector = ".".to_string();
            } else {
                break;
            }
        }
        if !member_path.is_empty() {
            expressions.push(MemberExpression {
                expression: line[owner_start..index].trim().to_string(),
                owner_name: owner,
                owner_indexed,
                first_connector: first_connector.to_string(),
                connectors,
                member_path,
                start: owner_start,
                end: index,
            });
        }
    }
    expressions
}

fn read_member_owner(line: &str, index: &mut usize) -> Option<(String, usize, bool)> {
    let bytes = line.as_bytes();
    if *index >= bytes.len() {
        return None;
    }
    let start = *index;
    if bytes[*index] == b'(' {
        let close = skip_bracket(line, *index);
        if close <= *index + 1 || close > line.len() {
            return None;
        }
        let inner = line[*index + 1..close - 1].trim();
        let mut inner_index = 0usize;
        let owner = read_identifier(inner, &mut inner_index)?;
        let rest = inner[inner_index..].trim();
        if rest.is_empty() {
            return None;
        }
        *index = close;
        return Some((owner, start, true));
    }
    read_identifier(line, index).map(|owner| (owner, start, false))
}

fn resolve_member_expression(
    expression: &MemberExpression,
    context: &NativeContext,
    local_types: &HashMap<String, LocalTypeInfo>,
    pointer_aliases: &HashMap<String, PointerAlias>,
    ambiguous_aliases: &HashSet<String>,
) -> Option<ResolvedMemberExpression> {
    let member_name = expression.member_path.last().cloned();
    if expression.first_connector == "." {
        let global_type = context.global_types.get(&expression.owner_name)?;
        if global_type.global.pointer_level.unwrap_or(0) > 0 {
            return None;
        }
        let owner_name = if global_type.global.is_array.unwrap_or(false) || expression.owner_indexed
        {
            format!("{}[]", expression.owner_name)
        } else {
            expression.owner_name.clone()
        };
        let target_name =
            canonical_member_name(&owner_name, &expression.connectors, &expression.member_path);
        if !member_path_exists(
            &global_type.type_info,
            &expression.member_path,
            &context.struct_types,
        ) {
            return Some(ResolvedMemberExpression {
                access_target_name: None,
                owner_name: Some(owner_name),
                member_name,
                unresolved_kind: Some("unknown-member-access".to_string()),
                unresolved_name: Some(target_name),
                unresolved_note: "global構造体のメンバ名を型表から確認できません。".to_string(),
            });
        }
        return Some(ResolvedMemberExpression {
            access_target_name: Some(target_name),
            owner_name: Some(owner_name),
            member_name,
            unresolved_kind: None,
            unresolved_name: None,
            unresolved_note: String::new(),
        });
    }

    if ambiguous_aliases.contains(&expression.owner_name) {
        return Some(ResolvedMemberExpression {
            access_target_name: None,
            owner_name: Some(expression.owner_name.clone()),
            member_name,
            unresolved_kind: Some("ambiguous-member-alias".to_string()),
            unresolved_name: Some(canonical_member_name(
                &expression.owner_name,
                &expression.connectors,
                &expression.member_path,
            )),
            unresolved_note:
                "ポインタ別名の代入先が複数候補になったため、メンバ更新先を断定していません。"
                    .to_string(),
        });
    }

    if let Some(alias) = pointer_aliases.get(&expression.owner_name) {
        let separator = if alias.pointer_owner { "->" } else { "." };
        return Some(ResolvedMemberExpression {
            access_target_name: Some(canonical_member_name_with_first_connector(
                &alias.owner_name,
                separator,
                expression,
            )),
            owner_name: Some(alias.owner_name.clone()),
            member_name,
            unresolved_kind: None,
            unresolved_name: None,
            unresolved_note: String::new(),
        });
    }

    if let Some(global_type) = context.global_types.get(&expression.owner_name) {
        if global_type.global.pointer_level.unwrap_or(0) > 0 {
            let owner_name =
                if global_type.global.is_array.unwrap_or(false) || expression.owner_indexed {
                    format!("{}[]", expression.owner_name)
                } else {
                    expression.owner_name.clone()
                };
            return Some(ResolvedMemberExpression {
                access_target_name: Some(canonical_member_name(
                    &owner_name,
                    &expression.connectors,
                    &expression.member_path,
                )),
                owner_name: Some(owner_name),
                member_name,
                unresolved_kind: None,
                unresolved_name: None,
                unresolved_note: String::new(),
            });
        }
    }

    if let Some(local_type) = local_types.get(&expression.owner_name) {
        let target = canonical_type_member_name(&local_type.type_name, &expression.member_path);
        return Some(ResolvedMemberExpression {
            access_target_name: Some(target.clone()),
            owner_name: Some(expression.owner_name.clone()),
            member_name,
            unresolved_kind: Some("unknown-member-access".to_string()),
            unresolved_name: Some(target),
            unresolved_note: "型は推定できましたが、ポインタ引数または局所ポインタの参照先globalを一意に断定していません。".to_string(),
        });
    }

    if member_name
        .as_ref()
        .is_some_and(|name| context.known_member_names.contains(name))
    {
        return Some(ResolvedMemberExpression {
            access_target_name: None,
            owner_name: Some(expression.owner_name.clone()),
            member_name,
            unresolved_kind: Some("unknown-member-access".to_string()),
            unresolved_name: Some(canonical_member_name(
                &expression.owner_name,
                &expression.connectors,
                &expression.member_path,
            )),
            unresolved_note: "ポインタの型と参照先を静的に断定していません。".to_string(),
        });
    }
    None
}

fn resolve_call_argument_owner(
    argument: &str,
    context: &NativeContext,
    local_types: &HashMap<String, LocalTypeInfo>,
    pointer_aliases: &HashMap<String, PointerAlias>,
    ambiguous_aliases: &HashSet<String>,
) -> Option<(String, String)> {
    let mut value = argument.trim();
    let mut address_taken = false;
    while let Some(rest) = value.strip_prefix('&') {
        address_taken = true;
        value = rest.trim();
    }
    if value.is_empty() {
        return None;
    }

    if let Some(expression) = extract_member_expressions(value)
        .into_iter()
        .find(|expression| expression.start == 0 && expression.end == value.len())
    {
        let resolved = resolve_member_expression(
            &expression,
            context,
            local_types,
            pointer_aliases,
            ambiguous_aliases,
        )?;
        return resolved
            .access_target_name
            .map(|target_name| (target_name, ".".to_string()));
    }

    let mut index = 0usize;
    let name = read_identifier(value, &mut index)?;
    skip_ascii_space(value, &mut index);
    if index != value.len() {
        return None;
    }
    if let Some(alias) = pointer_aliases.get(&name) {
        return Some((
            alias.owner_name.clone(),
            if alias.pointer_owner { "->" } else { "." }.to_string(),
        ));
    }
    if let Some(global_type) = context.global_types.get(&name) {
        if address_taken || global_type.global.pointer_level.unwrap_or(0) == 0 {
            return Some((name, ".".to_string()));
        }
        return Some((name, "->".to_string()));
    }
    None
}

fn member_path_exists(
    type_info: &StructTypeInfo,
    member_path: &[String],
    struct_types: &HashMap<String, StructTypeInfo>,
) -> bool {
    let mut current_type: Option<&StructTypeInfo> = Some(type_info);
    for (index, member_name) in member_path.iter().enumerate() {
        let Some(member) = current_type.and_then(|item| {
            item.members
                .iter()
                .find(|candidate| &candidate.name == member_name)
        }) else {
            return false;
        };
        if index < member_path.len() - 1 {
            current_type = member
                .type_name
                .as_ref()
                .and_then(|type_name| struct_types.get(type_name));
            if current_type.is_none() {
                return false;
            }
        }
    }
    true
}

fn canonical_member_name(
    owner_name: &str,
    connectors: &[String],
    member_path: &[String],
) -> String {
    let mut name = owner_name.to_string();
    for (index, member) in member_path.iter().enumerate() {
        let connector = connectors.get(index).map(String::as_str).unwrap_or(".");
        name.push_str(connector);
        name.push_str(member);
    }
    name
}

fn canonical_member_name_with_first_connector(
    owner_name: &str,
    first_connector: &str,
    expression: &MemberExpression,
) -> String {
    let mut connectors = expression.connectors.clone();
    if let Some(first) = connectors.first_mut() {
        *first = first_connector.to_string();
    }
    canonical_member_name(owner_name, &connectors, &expression.member_path)
}

fn append_member_path(owner_name: &str, first_connector: &str, member_path: &[String]) -> String {
    let connectors = std::iter::once(first_connector.to_string())
        .chain(std::iter::repeat(".".to_string()).take(member_path.len().saturating_sub(1)))
        .collect::<Vec<_>>();
    canonical_member_name(owner_name, &connectors, member_path)
}

fn canonical_type_member_name(type_name: &str, member_path: &[String]) -> String {
    format!("{type_name}::{}", member_path.join("."))
}

fn mask_ranges(line: &str, ranges: &[MemberExpression]) -> String {
    if ranges.is_empty() {
        return line.to_string();
    }
    let mut bytes = line.as_bytes().to_vec();
    for range in ranges {
        for index in range.start..range.end.min(bytes.len()) {
            bytes[index] = b' ';
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| line.to_string())
}

fn contains_word(line: &str, word: &str) -> bool {
    !word_positions(line, word).is_empty()
}

fn classify_access(line: &str, variable_name: &str) -> (String, Vec<String>) {
    let mut reasons = Vec::new();
    if is_increment_or_decrement(line, variable_name) {
        reasons.push("increment-decrement".to_string());
        return ("write".to_string(), reasons);
    }
    if is_assignment_target(line, variable_name) {
        reasons.push("assignment".to_string());
        return ("write".to_string(), reasons);
    }
    if is_address_taken(line, variable_name) {
        reasons.push("address-taken".to_string());
        return ("unknown".to_string(), reasons);
    }
    reasons.push("read-reference".to_string());
    ("read".to_string(), reasons)
}

fn is_increment_or_decrement(line: &str, variable_name: &str) -> bool {
    for start in word_positions(line, variable_name) {
        let before = line[..start].trim_end();
        let after = line[start + variable_name.len()..].trim_start();
        if before.ends_with("++")
            || before.ends_with("--")
            || after.starts_with("++")
            || after.starts_with("--")
        {
            return true;
        }
    }
    false
}

fn is_assignment_target(line: &str, variable_name: &str) -> bool {
    for start in word_positions(line, variable_name) {
        let mut rest = &line[start + variable_name.len()..];
        rest = rest.trim_start();
        if rest.starts_with('[') {
            let end = skip_bracket(rest, 0);
            rest = rest[end..].trim_start();
        }
        for op in [
            "<<=", ">>=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=",
        ] {
            if rest.starts_with(op) {
                if op == "=" && rest.starts_with("==") {
                    continue;
                }
                return true;
            }
        }
    }
    false
}

fn is_address_taken(line: &str, variable_name: &str) -> bool {
    for start in word_positions(line, variable_name) {
        let before = line[..start].trim_end();
        if before.ends_with('&') && !before.ends_with("&&") {
            return true;
        }
    }
    false
}

fn word_positions(line: &str, word: &str) -> Vec<usize> {
    let mut positions = Vec::new();
    let bytes = line.as_bytes();
    let word_bytes = word.as_bytes();
    if word_bytes.is_empty() || bytes.len() < word_bytes.len() {
        return positions;
    }
    let mut index = 0usize;
    while index + word_bytes.len() <= bytes.len() {
        if &bytes[index..index + word_bytes.len()] == word_bytes
            && is_word_boundary(bytes, index)
            && is_word_boundary(bytes, index + word_bytes.len())
        {
            positions.push(index);
            index += word_bytes.len();
        } else {
            index += 1;
        }
    }
    positions
}

fn location(file: &str, line: usize, raw: &str) -> SourceLocation {
    SourceLocation {
        file: file.to_string(),
        line,
        text: Some(raw.trim().to_string()),
    }
}

fn unresolved_evidence(
    kind: &str,
    function_name: Option<&str>,
    variable_name: Option<&str>,
    file: &str,
    line: usize,
    raw: &str,
    note: &str,
) -> UnresolvedEvidence {
    UnresolvedEvidence {
        kind: kind.to_string(),
        function_name: function_name.map(str::to_string),
        variable_name: variable_name.map(str::to_string),
        location: location(file, line, raw),
        evidence: raw.trim().to_string(),
        note: note.to_string(),
    }
}

fn expanded_evidence(raw: &str, masked: &str) -> Option<String> {
    let expanded = masked.trim();
    if expanded == raw.trim() {
        None
    } else {
        Some(expanded.to_string())
    }
}

fn macro_names_option(values: &[String]) -> Option<Vec<String>> {
    if values.is_empty() {
        None
    } else {
        Some(values.to_vec())
    }
}

fn find_simple_assignment(line: &str, name: &str) -> Option<(usize, String)> {
    for start in word_positions(line, name) {
        let mut index = start + name.len();
        skip_ascii_space(line, &mut index);
        if index < line.len() && line.as_bytes()[index] == b'=' && !line[index..].starts_with("==")
        {
            let value = line[index + 1..]
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            return Some((start, value));
        }
    }
    None
}

fn find_word(line: &str, word: &str) -> Option<usize> {
    word_positions(line, word).into_iter().next()
}

fn read_identifier(line: &str, index: &mut usize) -> Option<String> {
    let bytes = line.as_bytes();
    if *index >= bytes.len() || !is_ident_start(bytes[*index]) {
        return None;
    }
    let start = *index;
    *index += 1;
    while *index < bytes.len() && is_ident_continue(bytes[*index]) {
        *index += 1;
    }
    Some(line[start..*index].to_string())
}

fn skip_ascii_space(line: &str, index: &mut usize) {
    let bytes = line.as_bytes();
    while *index < bytes.len() && bytes[*index].is_ascii_whitespace() {
        *index += 1;
    }
}

fn skip_bracket(line: &str, start: usize) -> usize {
    let bytes = line.as_bytes();
    let open = bytes.get(start).copied();
    let close = match open {
        Some(b'[') => b']',
        Some(b'(') => b')',
        Some(b'{') => b'}',
        _ => return start,
    };
    let mut depth = 0usize;
    let mut index = start;
    while index < bytes.len() {
        if bytes[index] == open.unwrap() {
            depth += 1;
        } else if bytes[index] == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return index + 1;
            }
        }
        index += 1;
    }
    index
}

fn is_word_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0
        || index >= bytes.len()
        || !is_ident_continue(bytes[index - 1])
        || !is_ident_continue(bytes[index])
}

fn is_ident_start(value: u8) -> bool {
    value == b'_' || value.is_ascii_alphabetic()
}

fn is_ident_continue(value: u8) -> bool {
    value == b'_' || value.is_ascii_alphanumeric()
}

fn simplify_function_name(function_name: &str) -> String {
    function_name
        .rsplit("::")
        .next()
        .unwrap_or(function_name)
        .to_string()
}

fn alias_key(alias: &PointerAlias) -> String {
    format!(
        "{}:{}:{}:{}",
        alias.owner_name,
        alias.owner_type_name,
        if alias.is_array_owner { "array" } else { "" },
        if alias.pointer_owner { "ptr" } else { "" }
    )
}

fn scan_file(
    file: &str,
    tree_sitter_diagnostics: bool,
    encoding: SourceEncoding,
) -> Result<FileStructure, String> {
    Ok(scan_file_with_decode(file, tree_sitter_diagnostics, encoding)?.0)
}

fn scan_file_summary(
    file: &str,
    tree_sitter_diagnostics: bool,
    encoding: SourceEncoding,
) -> Result<FileSummary, String> {
    let decoded = read_source_text(file, encoding)?;
    let text = decoded.text;
    let signature = file_signature(file)?;
    let masked_lines = mask_lines(&text);
    let raw_lines: Vec<&str> = text.lines().collect();
    let mut unresolved = Vec::new();

    if tree_sitter_diagnostics {
        append_tree_sitter_diagnostic(file, &text, &mut unresolved)?;
    }

    let macro_definitions = parse_macros(file, &raw_lines, &masked_lines, &mut unresolved);
    let struct_types = parse_struct_types(file, &raw_lines, &masked_lines);
    let (functions, parameter_member_accesses) = parse_function_summaries(&masked_lines);
    let function_ranges: Vec<(usize, usize)> = functions
        .iter()
        .map(|function| (function.start_line, function.end_line))
        .collect();
    let globals = parse_globals_with_ranges(file, &masked_lines, &function_ranges);

    Ok(FileSummary {
        file: file.to_string(),
        signature,
        globals,
        struct_types,
        macro_definitions,
        functions,
        parameter_member_accesses,
        unresolved,
        decode_info: decoded.info,
    })
}

fn scan_file_with_decode(
    file: &str,
    tree_sitter_diagnostics: bool,
    encoding: SourceEncoding,
) -> Result<(FileStructure, DecodeInfo), String> {
    let decoded = read_source_text(file, encoding)?;
    let text = decoded.text;
    let signature = file_signature(file)?;
    let masked_lines = mask_lines(&text);
    let raw_lines: Vec<&str> = text.lines().collect();
    let mut unresolved = Vec::new();

    if tree_sitter_diagnostics {
        append_tree_sitter_diagnostic(file, &text, &mut unresolved)?;
    }

    let macro_definitions = parse_macros(file, &raw_lines, &masked_lines, &mut unresolved);
    let struct_types = parse_struct_types(file, &raw_lines, &masked_lines);
    let functions = parse_functions(file, &raw_lines, &masked_lines);
    let globals = parse_globals(file, &raw_lines, &masked_lines, &functions);

    Ok((
        FileStructure {
            file: file.to_string(),
            signature,
            globals,
            struct_types,
            macro_definitions,
            functions,
            unresolved,
        },
        decoded.info,
    ))
}

fn append_tree_sitter_diagnostic(
    file: &str,
    text: &str,
    unresolved: &mut Vec<UnresolvedEvidence>,
) -> Result<(), String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_cpp::LANGUAGE.into())
        .map_err(|error| format!("tree-sitter-cpp language init failed: {error}"))?;
    if let Some(tree) = parser.parse(text, None) {
        if tree.root_node().has_error() {
            unresolved.push(UnresolvedEvidence {
                kind: "macro".to_string(),
                function_name: None,
                variable_name: None,
                location: SourceLocation {
                    file: file.to_string(),
                    line: 1,
                    text: None,
                },
                evidence: "tree-sitter parse errors".to_string(),
                note: "Rust/tree-sitter backend parsed the file but reported syntax errors; review unresolved evidence.".to_string(),
            });
        }
    }
    Ok(())
}

struct DecodedSource {
    text: String,
    info: DecodeInfo,
}

fn read_source_text(file: &str, encoding: SourceEncoding) -> Result<DecodedSource, String> {
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    decode_source_bytes(&bytes, encoding).map_err(|error| format!("{file}: {error}"))
}

fn decode_source_bytes(bytes: &[u8], encoding: SourceEncoding) -> Result<DecodedSource, String> {
    match encoding {
        SourceEncoding::Auto => {
            if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
                let text = std::str::from_utf8(&bytes[3..])
                    .map_err(|error| error.to_string())?
                    .to_string();
                return Ok(DecodedSource {
                    text,
                    info: DecodeInfo {
                        used_encoding: "utf8-bom",
                        lossy: false,
                    },
                });
            }
            if let Ok(text) = std::str::from_utf8(bytes) {
                return Ok(DecodedSource {
                    text: text.to_string(),
                    info: DecodeInfo {
                        used_encoding: "utf8",
                        lossy: false,
                    },
                });
            }
            Ok(decode_cp932(bytes))
        }
        SourceEncoding::Utf8 => {
            let body = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
                &bytes[3..]
            } else {
                bytes
            };
            let text = std::str::from_utf8(body)
                .map_err(|error| error.to_string())?
                .to_string();
            Ok(DecodedSource {
                text,
                info: DecodeInfo {
                    used_encoding: if body.len() == bytes.len() {
                        "utf8"
                    } else {
                        "utf8-bom"
                    },
                    lossy: false,
                },
            })
        }
        SourceEncoding::Cp932 => Ok(decode_cp932(bytes)),
    }
}

fn decode_cp932(bytes: &[u8]) -> DecodedSource {
    let (text, _, had_errors) = SHIFT_JIS.decode(bytes);
    DecodedSource {
        text: text.into_owned(),
        info: DecodeInfo {
            used_encoding: "cp932",
            lossy: had_errors,
        },
    }
}

fn file_signature(file: &str) -> Result<FileSignature, String> {
    let metadata = fs::metadata(file).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    Ok(FileSignature {
        size: metadata.len(),
        mtime_ms: modified.as_secs_f64() * 1000.0,
    })
}

fn parse_macros(
    file: &str,
    raw_lines: &[&str],
    masked_lines: &[String],
    unresolved: &mut Vec<UnresolvedEvidence>,
) -> Vec<MacroDefinition> {
    let mut macros = Vec::new();
    for (index, masked) in masked_lines.iter().enumerate() {
        if let Some(captures) = DEFINE_RE.captures(masked) {
            let name = captures.get(1).unwrap().as_str().to_string();
            let is_function_like = captures.get(2).is_some();
            let raw = raw_lines
                .get(index)
                .copied()
                .unwrap_or("")
                .trim()
                .to_string();
            macros.push(MacroDefinition {
                name,
                replacement: captures
                    .get(3)
                    .map(|item| item.as_str().trim().to_string())
                    .unwrap_or_default(),
                file: file.to_string(),
                line: index + 1,
                declaration: raw.clone(),
                is_function_like,
                is_object_like: !is_function_like,
            });
            if is_function_like {
                unresolved.push(UnresolvedEvidence {
                    kind: "macro".to_string(),
                    function_name: None,
                    variable_name: None,
                    location: SourceLocation {
                        file: file.to_string(),
                        line: index + 1,
                        text: Some(raw.clone()),
                    },
                    evidence: raw,
                    note: "function-like macro is not expanded by the Rust sidecar.".to_string(),
                });
            }
        }
    }
    macros
}

fn parse_struct_types(
    file: &str,
    raw_lines: &[&str],
    masked_lines: &[String],
) -> Vec<StructTypeInfo> {
    let mut structs = Vec::new();
    let mut index = 0usize;
    while index < masked_lines.len() {
        let line = masked_lines.get(index).map(String::as_str).unwrap_or("");
        if !(line.contains("struct") || line.contains("class")) || !line.contains('{') {
            index += 1;
            continue;
        }
        let start_line = index + 1;
        let mut masked_block = String::new();
        let mut raw_block = String::new();
        let mut depth = 0isize;
        loop {
            let current = masked_lines.get(index).map(String::as_str).unwrap_or("");
            let raw = raw_lines.get(index).copied().unwrap_or("");
            masked_block.push_str(current);
            masked_block.push('\n');
            raw_block.push_str(raw);
            raw_block.push('\n');
            depth += count_char(current, '{') as isize - count_char(current, '}') as isize;
            let trimmed = current.trim();
            if depth <= 0 && trimmed.contains(';') {
                break;
            }
            index += 1;
            if index >= masked_lines.len() {
                break;
            }
        }
        if let Some(parsed) = parse_struct_block(file, start_line, &masked_block, &raw_block) {
            structs.push(parsed);
        }
        index += 1;
    }
    structs
}

fn parse_struct_block(
    file: &str,
    line: usize,
    masked_block: &str,
    raw_block: &str,
) -> Option<StructTypeInfo> {
    let open = masked_block.find('{')?;
    let close = masked_block.rfind('}')?;
    if close <= open {
        return None;
    }
    let header = masked_block[..open]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if !(header.contains("struct") || header.contains("class")) {
        return None;
    }
    let body = &masked_block[open + 1..close];
    let tail = masked_block[close + 1..]
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    let tag_name = TAG_RE
        .captures(&header)
        .and_then(|captures| captures.get(1).map(|item| item.as_str().to_string()));
    let typedef_aliases = if header.trim_start().starts_with("typedef") {
        extract_typedef_aliases(tail)
    } else {
        Vec::new()
    };
    let name = typedef_aliases
        .first()
        .cloned()
        .or_else(|| tag_name.clone())?;
    let mut aliases = Vec::new();
    if let Some(tag) = tag_name {
        aliases.push(tag);
    }
    aliases.extend(typedef_aliases);
    aliases = unique(aliases);
    Some(StructTypeInfo {
        name,
        aliases,
        file: file.to_string(),
        line,
        declaration: raw_block.lines().next().unwrap_or("").trim().to_string(),
        members: parse_struct_members(file, line, body),
    })
}

fn extract_typedef_aliases(tail: &str) -> Vec<String> {
    split_top_level_commas(tail)
        .iter()
        .filter_map(|part| {
            let declarator = part.split('=').next().unwrap_or("").trim();
            TYPEDEF_ALIAS_RE
                .captures(declarator)
                .and_then(|captures| captures.get(1).map(|item| item.as_str().to_string()))
        })
        .filter(|name| !is_keyword(name))
        .collect()
}

fn parse_struct_members(file: &str, start_line: usize, body: &str) -> Vec<StructMemberInfo> {
    let mut members = Vec::new();
    let mut line_offset = 0usize;
    for statement in body.split(';') {
        let statement_line = start_line + line_offset;
        line_offset += count_char(statement, '\n');
        let normalized = statement
            .replace("public:", " ")
            .replace("private:", " ")
            .replace("protected:", " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if normalized.is_empty()
            || normalized.contains('(')
            || normalized.contains(')')
            || normalized.contains('{')
        {
            continue;
        }
        let parts = split_top_level_commas(&normalized);
        let base_type = parts
            .first()
            .and_then(|part| type_name_from_declarator(part));
        for part in parts {
            if let Some(captures) = MEMBER_DECLARATOR_RE.captures(&part) {
                let name = captures.get(1).unwrap().as_str();
                if is_keyword(name) {
                    continue;
                }
                members.push(StructMemberInfo {
                    name: name.to_string(),
                    type_name: base_type.clone(),
                    file: file.to_string(),
                    line: statement_line,
                    declaration: normalized.clone(),
                    is_array: Some(captures.get(2).is_some()),
                    pointer_level: Some(part.chars().filter(|item| *item == '*').count()),
                });
            }
        }
    }
    members
}

fn parse_functions(
    file: &str,
    raw_lines: &[&str],
    masked_lines: &[String],
) -> Vec<FunctionStructure> {
    let mut functions = Vec::new();
    let mut pending = String::new();
    let mut pending_start = 1usize;
    let mut active: Option<FunctionStructure> = None;
    let mut brace_depth = 0isize;

    for (index, masked) in masked_lines.iter().enumerate() {
        let line = index + 1;
        let raw = raw_lines.get(index).copied().unwrap_or("").to_string();
        if masked.trim_start().starts_with('#') {
            continue;
        }
        if let Some(func) = active.as_mut() {
            func.body_lines.push(body_line(line, &raw, masked));
            brace_depth += count_char(masked, '{') as isize - count_char(masked, '}') as isize;
            if brace_depth <= 0 {
                func.end_line = line;
                functions.push(active.take().unwrap());
            }
            continue;
        }
        let trimmed = masked.trim();
        if trimmed.is_empty() {
            continue;
        }
        if pending.is_empty() {
            pending_start = line;
        }
        pending = format!("{} {}", pending, trimmed).trim().to_string();
        if let Some(open) = pending.find('{') {
            let signature = pending[..open]
                .replace(char::is_whitespace, " ")
                .trim()
                .to_string();
            if let Some(name) = function_name(&signature) {
                let mut func = FunctionStructure {
                    name,
                    file: file.to_string(),
                    start_line: pending_start,
                    end_line: line,
                    signature,
                    body_lines: vec![body_line(line, &raw, masked)],
                };
                brace_depth = count_char(masked, '{') as isize - count_char(masked, '}') as isize;
                pending.clear();
                if brace_depth <= 0 {
                    func.end_line = line;
                    functions.push(func);
                } else {
                    active = Some(func);
                }
                continue;
            }
            pending.clear();
        }
        if pending.contains(';') {
            pending.clear();
        }
    }
    functions
}

struct ActiveFunctionSummary {
    summary: FunctionSummary,
    parameter_index_by_name: HashMap<String, usize>,
    templates: Vec<ParameterMemberAccessTemplate>,
    seen_templates: HashSet<String>,
}

fn parse_function_summaries(
    masked_lines: &[String],
) -> (
    Vec<FunctionSummary>,
    HashMap<String, Vec<ParameterMemberAccessTemplate>>,
) {
    let mut functions = Vec::new();
    let mut templates_by_function = HashMap::new();
    let mut pending = String::new();
    let mut pending_start = 1usize;
    let mut active: Option<ActiveFunctionSummary> = None;
    let mut brace_depth = 0isize;

    for (index, masked) in masked_lines.iter().enumerate() {
        let line = index + 1;
        if masked.trim_start().starts_with('#') {
            continue;
        }
        if let Some(active_function) = active.as_mut() {
            collect_parameter_member_access_templates(
                masked,
                &active_function.parameter_index_by_name,
                &mut active_function.templates,
                &mut active_function.seen_templates,
            );
            brace_depth += count_char(masked, '{') as isize - count_char(masked, '}') as isize;
            if brace_depth <= 0 {
                let mut finished = active.take().unwrap();
                finished.summary.end_line = line;
                finish_function_summary(finished, &mut functions, &mut templates_by_function);
            }
            continue;
        }
        let trimmed = masked.trim();
        if trimmed.is_empty() {
            continue;
        }
        if pending.is_empty() {
            pending_start = line;
        }
        pending = format!("{} {}", pending, trimmed).trim().to_string();
        if let Some(open) = pending.find('{') {
            let signature = pending[..open]
                .replace(char::is_whitespace, " ")
                .trim()
                .to_string();
            if let Some(name) = function_name(&signature) {
                let parameter_names = parameter_names_from_signature(&signature);
                let parameter_index_by_name: HashMap<String, usize> = parameter_names
                    .iter()
                    .enumerate()
                    .map(|(index, name)| (name.clone(), index))
                    .collect();
                let mut active_function = ActiveFunctionSummary {
                    summary: FunctionSummary {
                        name,
                        start_line: pending_start,
                        end_line: line,
                        signature,
                    },
                    parameter_index_by_name,
                    templates: Vec::new(),
                    seen_templates: HashSet::new(),
                };
                collect_parameter_member_access_templates(
                    masked,
                    &active_function.parameter_index_by_name,
                    &mut active_function.templates,
                    &mut active_function.seen_templates,
                );
                brace_depth = count_char(masked, '{') as isize - count_char(masked, '}') as isize;
                pending.clear();
                if brace_depth <= 0 {
                    finish_function_summary(
                        active_function,
                        &mut functions,
                        &mut templates_by_function,
                    );
                } else {
                    active = Some(active_function);
                }
                continue;
            }
            pending.clear();
        }
        if pending.contains(';') {
            pending.clear();
        }
    }
    functions.shrink_to_fit();
    (functions, templates_by_function)
}

fn finish_function_summary(
    active: ActiveFunctionSummary,
    functions: &mut Vec<FunctionSummary>,
    templates_by_function: &mut HashMap<String, Vec<ParameterMemberAccessTemplate>>,
) {
    if !active.templates.is_empty() {
        templates_by_function.insert(active.summary.name.clone(), active.templates);
    }
    functions.push(active.summary);
}

fn parse_globals(
    file: &str,
    _raw_lines: &[&str],
    masked_lines: &[String],
    functions: &[FunctionStructure],
) -> Vec<GlobalVariable> {
    let function_ranges: Vec<(usize, usize)> = functions
        .iter()
        .map(|func| (func.start_line, func.end_line))
        .collect();
    parse_globals_with_ranges(file, masked_lines, &function_ranges)
}

fn parse_globals_with_ranges(
    file: &str,
    masked_lines: &[String],
    function_ranges: &[(usize, usize)],
) -> Vec<GlobalVariable> {
    let mut globals = Vec::new();
    let mut pending = String::new();
    let mut pending_line = 1usize;
    let mut block_depth = 0isize;
    let mut type_block_pending = false;
    for (index, masked) in masked_lines.iter().enumerate() {
        let line = index + 1;
        if function_ranges
            .iter()
            .any(|(start, end)| line >= *start && line <= *end)
            || masked.trim_start().starts_with('#')
        {
            continue;
        }
        let trimmed = masked.trim();
        if trimmed.is_empty() {
            continue;
        }
        if block_depth > 0 {
            block_depth += count_char(masked, '{') as isize - count_char(masked, '}') as isize;
            if block_depth <= 0 && trimmed.contains(';') {
                block_depth = 0;
                type_block_pending = false;
            }
            continue;
        }
        if type_block_pending {
            if trimmed.contains('{') {
                block_depth = count_char(masked, '{') as isize - count_char(masked, '}') as isize;
                if block_depth <= 0 && trimmed.contains(';') {
                    block_depth = 0;
                    type_block_pending = false;
                }
            } else if trimmed.contains(';') {
                type_block_pending = false;
            }
            continue;
        }
        if trimmed.starts_with("typedef struct")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("typedef class")
        {
            if trimmed.contains('{') {
                block_depth = count_char(masked, '{') as isize - count_char(masked, '}') as isize;
                if block_depth <= 0 && trimmed.contains(';') {
                    block_depth = 0;
                }
            } else if !trimmed.contains(';') {
                type_block_pending = true;
            }
            continue;
        }
        if pending.is_empty() {
            pending_line = line;
        }
        pending = format!("{} {}", pending, trimmed).trim().to_string();
        if !pending.contains(';') {
            continue;
        }
        for statement in pending.split(';').take_while(|part| !part.is_empty()) {
            let normalized = statement.split_whitespace().collect::<Vec<_>>().join(" ");
            if should_skip_global(&normalized) {
                continue;
            }
            let declarator = normalized.split('=').next().unwrap_or("").trim();
            if let Some(captures) = GLOBAL_DECLARATOR_RE.captures(declarator) {
                let name = captures.get(1).unwrap().as_str();
                if is_keyword(name) {
                    continue;
                }
                globals.push(GlobalVariable {
                    name: name.to_string(),
                    file: file.to_string(),
                    line: pending_line,
                    declaration: normalized.clone(),
                    is_extern: normalized.contains("extern "),
                    type_name: type_name_from_declarator(declarator),
                    is_array: Some(captures.get(2).is_some()),
                    pointer_level: Some(declarator.chars().filter(|item| *item == '*').count()),
                });
            }
        }
        pending.clear();
    }
    globals
}

fn body_line(line: usize, raw: &str, masked: &str) -> BodyLine {
    BodyLine {
        line,
        raw: raw.to_string(),
        masked: masked.to_string(),
        identifiers: identifiers(masked),
        call_identifiers: call_identifiers(masked),
    }
}

fn function_name(signature: &str) -> Option<String> {
    let control = ["if", "for", "while", "switch", "catch", "return", "sizeof"];
    if control.iter().any(|keyword| signature.starts_with(keyword)) || signature.contains(';') {
        return None;
    }
    FUNCTION_NAME_RE
        .captures(signature)
        .and_then(|captures| captures.get(1).map(|item| item.as_str().to_string()))
}

fn identifiers(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_ident_start(bytes[index]) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_ident_continue(bytes[index]) {
                index += 1;
            }
            let value = line[start..index].to_string();
            if seen.insert(value.clone()) {
                result.push(value);
            }
        } else {
            index += 1;
        }
    }
    result
}

fn call_identifiers(line: &str) -> Vec<String> {
    let control = ["if", "for", "while", "switch", "catch", "return", "sizeof"];
    let bytes = line.as_bytes();
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_ident_start(bytes[index]) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_ident_continue(bytes[index]) {
                index += 1;
            }
            let value = &line[start..index];
            let mut lookahead = index;
            skip_ascii_space(line, &mut lookahead);
            if lookahead < bytes.len()
                && bytes[lookahead] == b'('
                && !control.contains(&value)
                && seen.insert(value.to_string())
            {
                result.push(value.to_string());
            }
        } else {
            index += 1;
        }
    }
    result
}

fn direct_calls(line: &str) -> Vec<DirectCall> {
    let control = ["if", "for", "while", "switch", "catch", "return", "sizeof"];
    let bytes = line.as_bytes();
    let mut calls = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if is_ident_start(bytes[index]) {
            let start = index;
            index += 1;
            while index < bytes.len() && is_ident_continue(bytes[index]) {
                index += 1;
            }
            let value = &line[start..index];
            let mut lookahead = index;
            skip_ascii_space(line, &mut lookahead);
            if lookahead < bytes.len() && bytes[lookahead] == b'(' && !control.contains(&value) {
                let close = skip_bracket(line, lookahead);
                if close > lookahead + 1 && close <= line.len() {
                    calls.push(DirectCall {
                        name: value.to_string(),
                        arguments: split_top_level_commas(&line[lookahead + 1..close - 1]),
                    });
                    index = close;
                    continue;
                }
            }
        } else {
            index += 1;
        }
    }
    calls
}

fn type_name_from_declarator(declarator: &str) -> Option<String> {
    let before_name = GLOBAL_DECLARATOR_RE.replace(declarator, "");
    let tokens: Vec<&str> = before_name
        .split(|ch: char| ch.is_whitespace() || ch == '*' || ch == '&')
        .filter(|token| !token.is_empty())
        .filter(|token| {
            ![
                "const", "volatile", "static", "extern", "register", "struct", "class",
            ]
            .contains(token)
        })
        .collect();
    tokens.last().map(|item| item.to_string())
}

fn should_skip_global(statement: &str) -> bool {
    statement.starts_with('#')
        || statement.contains('(')
        || statement.contains(')')
        || [
            "typedef",
            "using",
            "return",
            "goto",
            "break",
            "continue",
            "struct",
            "class",
            "enum",
            "namespace",
        ]
        .iter()
        .any(|keyword| {
            statement.starts_with(keyword) || statement.contains(&format!(" {keyword} "))
        })
}

fn split_top_level_commas(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut paren_depth = 0isize;
    let mut bracket_depth = 0isize;
    let mut brace_depth = 0isize;
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => paren_depth += 1,
            ')' => paren_depth = (paren_depth - 1).max(0),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = (bracket_depth - 1).max(0),
            '{' => brace_depth += 1,
            '}' => brace_depth = (brace_depth - 1).max(0),
            ',' if paren_depth == 0 && bracket_depth == 0 && brace_depth == 0 => {
                let part = value[start..index].trim();
                if !part.is_empty() {
                    parts.push(part.to_string());
                }
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }
    let part = value[start..].trim();
    if !part.is_empty() {
        parts.push(part.to_string());
    }
    parts
}

fn is_keyword(value: &str) -> bool {
    [
        "int", "char", "short", "long", "float", "double", "void", "const", "volatile", "static",
        "extern", "unsigned", "signed", "struct", "class", "enum",
    ]
    .contains(&value)
}

fn mask_lines(text: &str) -> Vec<String> {
    let mut in_block = false;
    text.lines()
        .map(|line| mask_comments_and_strings(line, &mut in_block))
        .collect()
}

fn mask_comments_and_strings(line: &str, in_block: &mut bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut output = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if *in_block {
            if ch == '*' && next == Some('/') {
                *in_block = false;
                output.push_str("  ");
                index += 2;
            } else {
                output.push(' ');
                index += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            *in_block = true;
            output.push_str("  ");
            index += 2;
            continue;
        }
        if ch == '/' && next == Some('/') {
            output.push_str(&" ".repeat(chars.len() - index));
            break;
        }
        if ch == '"' || ch == '\'' {
            let quote = ch;
            output.push(' ');
            index += 1;
            while index < chars.len() {
                let quoted = chars[index];
                output.push(' ');
                if quoted == '\\' && index + 1 < chars.len() {
                    output.push(' ');
                    index += 2;
                } else {
                    index += 1;
                    if quoted == quote {
                        break;
                    }
                }
            }
            continue;
        }
        output.push(ch);
        index += 1;
    }
    output
}

fn count_char(value: &str, ch: char) -> usize {
    value.chars().filter(|item| *item == ch).count()
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    result
}

fn normalize_path(value: &str) -> String {
    let normalized = Path::new(value)
        .canonicalize()
        .unwrap_or_else(|_| Path::new(value).to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_analysis_detects_globals_members_macros_and_unresolved() {
        let file = write_temp_source("native_fixture.cpp", &fixture_source());
        let result = analyze_many_legacy(vec![file], test_options(256, true))
            .expect("native analysis should succeed");
        let analysis = result.files.first().expect("file analysis");
        let globals: HashSet<_> = analysis
            .globals
            .iter()
            .map(|item| item.name.as_str())
            .collect();
        assert!(globals.contains("g_counter"));
        assert!(globals.contains("g_deviceState"));
        assert!(!globals.contains("counter"));

        let worker = analysis
            .functions
            .iter()
            .find(|func| func.name == "Worker")
            .expect("Worker function");
        assert!(worker
            .accesses
            .iter()
            .any(|access| access.variable_name == "g_counter" && access.kind == "write"));
        assert!(worker.accesses.iter().any(|access| access.variable_name
            == "g_deviceState.counter"
            && access.kind == "write"));
        assert!(worker.accesses.iter().any(|access| {
            access.variable_name == "g_deviceState.counter"
                && access.kind == "read"
                && access
                    .macro_names
                    .as_ref()
                    .is_some_and(|names| names.iter().any(|name| name == "DEVICE_COUNTER_ALIAS"))
        }));
        assert!(worker.accesses.iter().any(|access| {
            access.variable_name == "g_parent->child->value" && access.kind == "write"
        }));
        assert!(worker.accesses.iter().any(|access| {
            access.variable_name == "g_deviceArrayPtr[]->counter" && access.kind == "write"
        }));
        assert!(worker.accesses.iter().any(|access| {
            access.variable_name == "g_deviceState.counter"
                && access.kind == "write"
                && access
                    .reasons
                    .iter()
                    .any(|reason| reason == "call-argument-alias")
        }));
        let api_dispatch = analysis
            .functions
            .iter()
            .find(|func| func.name == "ApiDispatch")
            .expect("ApiDispatch function");
        assert!(api_dispatch.calls.iter().any(|call| call == "ApiTarget1"));
        assert!(api_dispatch.calls.iter().any(|call| call == "ApiTarget2"));
        assert!(!api_dispatch
            .unresolved
            .iter()
            .any(|item| item.kind == "function-pointer" && item.evidence.contains("dispatch")));
        assert!(worker
            .unresolved
            .iter()
            .any(|item| item.kind == "inline-asm"));
        assert!(worker
            .unresolved
            .iter()
            .any(|item| item.kind == "function-pointer"));
        assert!(worker
            .unresolved
            .iter()
            .any(|item| item.kind == "address-taken"
                && item.variable_name.as_deref() == Some("g_deviceState")));
    }

    #[test]
    fn native_analysis_worker_count_does_not_change_result() {
        let first = write_temp_source("native_fixture_one.cpp", &fixture_source());
        let second = write_temp_source("native_fixture_two.cpp", &fixture_source());
        let single =
            analyze_many_legacy(vec![first.clone(), second.clone()], test_options(256, true))
                .expect("single worker analysis");
        let auto = analyze_many_legacy(
            vec![first, second],
            AnalyzeOptions {
                workers: None,
                ..test_options(256, true)
            },
        )
        .expect("auto worker analysis");

        assert_eq!(summarize(&single.files), summarize(&auto.files));
    }

    #[test]
    fn analyze_options_defaults_to_small_low_memory_batch() {
        let options = parse_analyze_options(&[]).expect("options should parse");

        assert_eq!(options.batch_size, 1);
    }

    #[test]
    fn analyze_options_accept_output_batch_encoding_and_legacy_flags() {
        let args = vec![
            "--workers".to_string(),
            "2".to_string(),
            "--output".to_string(),
            "out.json".to_string(),
            "--batch-size".to_string(),
            "7".to_string(),
            "--encoding".to_string(),
            "cp932".to_string(),
            "--legacy-in-memory".to_string(),
        ];

        let options = parse_analyze_options(&args).expect("options should parse");

        assert_eq!(options.workers, Some(2));
        assert_eq!(options.output.as_deref(), Some("out.json"));
        assert_eq!(options.batch_size, 7);
        assert_eq!(options.encoding, SourceEncoding::Cp932);
        assert!(options.legacy_in_memory);
    }

    #[test]
    fn cp932_source_decodes_and_analyzes_global_access() {
        let source = encode_cp932(
            "// 日本語\r\nint g_cp932_counter;\r\nvoid Worker(void) { g_cp932_counter++; }\r\n",
        );
        let file = write_temp_source_bytes("cp932_fixture.cpp", &source);
        let result = analyze_many_legacy(
            vec![file],
            AnalyzeOptions {
                workers: Some(1),
                tree_sitter_diagnostics: false,
                output: None,
                batch_size: 256,
                legacy_in_memory: true,
                encoding: SourceEncoding::Auto,
            },
        )
        .expect("cp932 source should analyze");
        let analysis = result.files.first().expect("file analysis");

        assert!(analysis
            .globals
            .iter()
            .any(|global| global.name == "g_cp932_counter"));
        assert!(analysis.functions.iter().any(|func| func.name == "Worker"
            && func
                .accesses
                .iter()
                .any(|access| access.variable_name == "g_cp932_counter")));
    }

    #[test]
    fn low_memory_analysis_matches_legacy_for_fixture_and_batch_size_one() {
        let first = write_temp_source("low_memory_one.cpp", &fixture_source());
        let second = write_temp_source("low_memory_two.cpp", &fixture_source());
        let files = vec![first, second];
        let legacy =
            analyze_many_legacy(files.clone(), test_options(256, true)).expect("legacy analysis");

        let mut output = Vec::new();
        analyze_many_low_memory_to_writer(files, test_options(1, false), &mut output)
            .expect("low memory analysis");
        let low_memory: NativeAnalysisResult =
            serde_json::from_slice(&output).expect("low memory json");

        assert_eq!(summarize(&legacy.files), summarize(&low_memory.files));
    }

    #[test]
    fn low_memory_parallel_streaming_caps_retained_files_to_batch_size() {
        let first = write_temp_source("streaming_one.cpp", &fixture_source());
        let second = write_temp_source("streaming_two.cpp", &fixture_source());
        let third = write_temp_source("streaming_three.cpp", &fixture_source());
        let fourth = write_temp_source("streaming_four.cpp", &fixture_source());
        let files = vec![first, second, third, fourth];

        let mut output = Vec::new();
        analyze_many_low_memory_to_writer(files, test_options(2, false), &mut output)
            .expect("low memory analysis");
        let low_memory: NativeAnalysisResult =
            serde_json::from_slice(&output).expect("low memory json");

        assert_eq!(low_memory.files.len(), 4);
        assert_eq!(low_memory.metrics.get("streamedFileCount"), Some(&4));
        assert_eq!(low_memory.metrics.get("maxStructureBatchFiles"), Some(&2));
    }

    #[test]
    fn atomic_output_does_not_publish_partial_json_on_failure() {
        let output = write_temp_source("partial-output.json", "{}");
        fs::remove_file(&output).expect("remove placeholder");

        let result = write_atomic_json_output(&output, |writer| {
            writer
                .write_all(b"{\"files\":[")
                .map_err(|error| error.to_string())?;
            Err("forced failure".to_string())
        });

        assert!(result.is_err());
        assert!(!Path::new(&output).exists());
    }

    #[test]
    fn summary_scan_keeps_function_ranges_and_deduped_parameter_templates_without_full_analysis() {
        let source = [
            "typedef struct tagDEVICE_STATE {",
            "    int counter;",
            "} DEVICE_STATE;",
            "void Touch(DEVICE_STATE *state)",
            "{",
            "    state->counter++;",
            "    state->counter++;",
            "}",
            "DEVICE_STATE g_after;",
        ]
        .join("\n");
        let file = write_temp_source("summary_ranges.cpp", &source);

        let summary = scan_file_summary(&file, false, SourceEncoding::Auto)
            .expect("summary scan should pass");
        let touch = summary
            .functions
            .iter()
            .find(|function| function.name == "Touch")
            .expect("Touch summary");
        let templates = summary
            .parameter_member_accesses
            .get("Touch")
            .expect("Touch parameter templates");

        assert_eq!(touch.start_line, 4);
        assert_eq!(touch.end_line, 8);
        assert_eq!(touch.signature, "void Touch(DEVICE_STATE *state)");
        assert!(summary
            .globals
            .iter()
            .any(|global| global.name == "g_after"));
        assert_eq!(templates.len(), 1);
    }

    #[test]
    fn ascii_scanners_ignore_comments_strings_and_detect_calls() {
        let mut in_block = false;
        let masked =
            mask_comments_and_strings("CallMe(g_counter); // OtherCall(g_counter)", &mut in_block);
        assert_eq!(call_identifiers(&masked), vec!["CallMe".to_string()]);
        let masked = mask_comments_and_strings("\"g_counter\" g_counter++;", &mut in_block);
        assert_eq!(identifiers(&masked), vec!["g_counter".to_string()]);
        let classified = classify_access("g_counter++;", "g_counter");
        assert_eq!(classified.0, "write");
    }

    fn write_temp_source(name: &str, text: &str) -> String {
        let dir = std::env::temp_dir().join(format!("vc6-impact-rust-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join(name);
        fs::write(&file, text).expect("write source");
        normalize_path(file.to_string_lossy().as_ref())
    }

    fn write_temp_source_bytes(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("vc6-impact-rust-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join(name);
        fs::write(&file, bytes).expect("write source");
        normalize_path(file.to_string_lossy().as_ref())
    }

    fn encode_cp932(text: &str) -> Vec<u8> {
        let (encoded, _, _) = SHIFT_JIS.encode(text);
        encoded.into_owned()
    }

    fn test_options(batch_size: usize, legacy_in_memory: bool) -> AnalyzeOptions {
        AnalyzeOptions {
            workers: Some(1),
            tree_sitter_diagnostics: false,
            output: None,
            batch_size,
            legacy_in_memory,
            encoding: SourceEncoding::Auto,
        }
    }

    fn fixture_source() -> String {
        [
            "typedef struct tagDEVICE_STATE {",
            "    int counter;",
            "    int mode;",
            "} DEVICE_STATE;",
            "typedef struct tagDEVICE_CHILD {",
            "    int value;",
            "} DEVICE_CHILD;",
            "typedef struct tagDEVICE_PARENT {",
            "    DEVICE_CHILD *child;",
            "} DEVICE_PARENT;",
            "int g_counter;",
            "DEVICE_STATE g_deviceState;",
            "DEVICE_STATE *g_deviceArrayPtr;",
            "DEVICE_CHILD g_child;",
            "DEVICE_PARENT *g_parent;",
            "#define DEVICE_COUNTER_ALIAS g_deviceState.counter",
            "void Target(void) {}",
            "void ChildWriter(DEVICE_STATE *state) { state->counter++; }",
            "int ApiTarget1(int value) { return value; }",
            "int ApiTarget2(int value) { return value + 1; }",
            "int ApiDispatch(int index)",
            "{",
            "    int (*dispatch[])(int value) =",
            "    {",
            "        &ApiTarget1,",
            "        &ApiTarget2",
            "    };",
            "    return dispatch[index](index);",
            "}",
            "void Worker(void)",
            "{",
            "    DEVICE_STATE *p = &g_deviceState;",
            "    g_counter++;",
            "    p->counter = DEVICE_COUNTER_ALIAS;",
            "    g_parent->child->value++;",
            "    (g_deviceArrayPtr + 1)->counter++;",
            "    ChildWriter(&g_deviceState);",
            "    __asm nop",
            "    void (*callback)(void);",
            "    (*callback)();",
            "    Target();",
            "}",
        ]
        .join("\n")
    }

    fn summarize(files: &[FileAnalysis]) -> Vec<(usize, usize, usize)> {
        files
            .iter()
            .map(|file| {
                let accesses = file.functions.iter().map(|func| func.accesses.len()).sum();
                let unresolved = file.unresolved.len()
                    + file
                        .functions
                        .iter()
                        .map(|func| func.unresolved.len())
                        .sum::<usize>();
                (file.globals.len(), accesses, unresolved)
            })
            .collect()
    }
}
