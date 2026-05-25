import * as fs from "node:fs/promises";
import { TextDecoder } from "node:util";

export type TextEncoding = "auto" | "utf8" | "cp932";

export interface DecodedText {
  text: string;
  usedEncoding: "utf8-bom" | "utf8" | "cp932";
  lossy: boolean;
}

export async function readTextFile(file: string, encoding: TextEncoding = "auto"): Promise<DecodedText> {
  const bytes = await fs.readFile(file);
  return decodeText(bytes, encoding, file);
}

export function normalizeTextEncoding(value: string | undefined, fallback: TextEncoding = "auto"): TextEncoding {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "utf8" || normalized === "cp932") {
    return normalized;
  }
  return fallback;
}

export function decodeText(bytes: Uint8Array, encoding: TextEncoding = "auto", label = "buffer"): DecodedText {
  if (encoding === "auto") {
    if (hasUtf8Bom(bytes)) {
      return { text: decodeUtf8(bytes.subarray(3), label), usedEncoding: "utf8-bom", lossy: false };
    }
    try {
      return { text: decodeUtf8(bytes, label), usedEncoding: "utf8", lossy: false };
    } catch {
      return decodeCp932(bytes);
    }
  }

  if (encoding === "utf8") {
    const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
    return { text: decodeUtf8(body, label), usedEncoding: hasUtf8Bom(bytes) ? "utf8-bom" : "utf8", lossy: false };
  }

  return decodeCp932(bytes);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeCp932(bytes: Uint8Array): DecodedText {
  try {
    return {
      text: new TextDecoder("shift_jis", { fatal: true }).decode(bytes),
      usedEncoding: "cp932",
      lossy: false
    };
  } catch {
    return {
      text: new TextDecoder("shift_jis").decode(bytes),
      usedEncoding: "cp932",
      lossy: true
    };
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}
