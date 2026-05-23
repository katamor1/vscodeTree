const fs = require("node:fs/promises");
const path = require("node:path");

const samples = [
  "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-small-sample-1of50",
  "C:/Users/stell/source/repos/vscodeTree_perf_samples/vc6-large-sample"
];

async function main() {
  for (const root of samples) {
    await enrichSample(root);
  }
}

async function enrichSample(root) {
  const srcDir = path.join(root, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await writeIfChanged(path.join(srcDir, "struct_members.h"), renderHeader());
  await writeIfChanged(path.join(srcDir, "struct_members.cpp"), renderSource());
  await ensureGlobalsInclude(path.join(srcDir, "globals.h"));
  await ensureDspSources(root);
  await ensureThreadCalls(path.join(srcDir, "main.cpp"));
}

function renderHeader() {
  return [
    "#ifndef GENERATED_STRUCT_MEMBERS_H",
    "#define GENERATED_STRUCT_MEMBERS_H",
    "",
    "typedef struct tagSampleNestedState {",
    "    int flag;",
    "} SAMPLE_NESTED_STATE;",
    "",
    "typedef struct tagSampleDeviceState {",
    "    int mode;",
    "    int counter;",
    "    int status;",
    "    SAMPLE_NESTED_STATE nested;",
    "} SAMPLE_DEVICE_STATE;",
    "",
    "extern SAMPLE_DEVICE_STATE g_member_state;",
    "extern SAMPLE_DEVICE_STATE g_member_devices[4];",
    "",
    "void StructMember_Worker(int step);",
    "void StructMember_Monitor(int step);",
    "void StructMember_Interrupt(int step);",
    "void StructMember_Unknown(SAMPLE_DEVICE_STATE *state);",
    "",
    "#endif",
    ""
  ].join("\n");
}

function renderSource() {
  return [
    "#include \"globals.h\"",
    "",
    "SAMPLE_DEVICE_STATE g_member_state = {0, 0, 0, {0}};",
    "SAMPLE_DEVICE_STATE g_member_devices[4] = {",
    "    {0, 0, 0, {0}},",
    "    {1, 1, 1, {0}},",
    "    {2, 2, 2, {0}},",
    "    {3, 3, 3, {0}}",
    "};",
    "",
    "void StructMember_Worker(int step)",
    "{",
    "    SAMPLE_DEVICE_STATE *state = &g_member_state;",
    "    state->counter += step;",
    "    g_member_state.mode = state->counter;",
    "}",
    "",
    "void StructMember_Monitor(int step)",
    "{",
    "    if (g_member_state.counter > step) {",
    "        g_member_devices[step & 3].status = g_member_state.mode;",
    "    }",
    "}",
    "",
    "void StructMember_Interrupt(int step)",
    "{",
    "    g_member_state.counter = 0;",
    "    g_member_state.nested.flag++;",
    "    StructMember_Unknown((SAMPLE_DEVICE_STATE *)step);",
    "}",
    "",
    "void StructMember_Unknown(SAMPLE_DEVICE_STATE *state)",
    "{",
    "    state->mode = 7;",
    "}",
    ""
  ].join("\n");
}

async function ensureGlobalsInclude(file) {
  let text = await fs.readFile(file, "utf8");
  if (text.includes("#include \"struct_members.h\"")) {
    return;
  }
  text = text.replace(/#define GENERATED_GLOBALS_H\r?\n/, (match) => `${match}\n#include "struct_members.h"\n`);
  await fs.writeFile(file, text, "utf8");
}

async function ensureDspSources(root) {
  const dsp = (await fs.readdir(root)).find((name) => name.toLowerCase().endsWith(".dsp"));
  if (!dsp) {
    return;
  }
  const file = path.join(root, dsp);
  let text = await fs.readFile(file, "utf8");
  text = ensureDspSource(text, ".\\src\\struct_members.h");
  text = ensureDspSource(text, ".\\src\\struct_members.cpp");
  await fs.writeFile(file, text, "utf8");
}

function ensureDspSource(text, sourcePath) {
  if (text.includes(`SOURCE=${sourcePath}`)) {
    return text;
  }
  const block = [
    "# Begin Source File",
    `SOURCE=${sourcePath}`,
    "# End Source File",
    ""
  ].join("\n");
  return text.replace("# Begin Source File", `${block}# Begin Source File`);
}

async function ensureThreadCalls(file) {
  let text = await fs.readFile(file, "utf8");
  text = ensureCall(text, "ThreadEntry_00", "StructMember_Interrupt(step);");
  text = ensureCall(text, "ThreadEntry_01", "StructMember_Worker(step);");
  text = ensureCall(text, "ThreadEntry_02", "StructMember_Monitor(step);");
  await fs.writeFile(file, text, "utf8");
}

function ensureCall(text, entryName, callLine) {
  const start = text.indexOf(`unsigned long ${entryName}`);
  if (start < 0) {
    return text;
  }
  const end = text.indexOf("\n}\n", start);
  const functionText = text.slice(start, end > start ? end : undefined);
  if (functionText.includes(callLine)) {
    return text;
  }
  const pattern = new RegExp(`(unsigned long ${entryName}\\([^)]*\\)\\r?\\n\\{\\r?\\n\\s*int step = \\(int\\)\\(long\\)param;\\r?\\n)`);
  return text.replace(pattern, `$1    ${callLine}\n`);
}

async function writeIfChanged(file, text) {
  try {
    const current = await fs.readFile(file, "utf8");
    if (current === text) {
      return;
    }
  } catch {
    // create below
  }
  await fs.writeFile(file, text, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
