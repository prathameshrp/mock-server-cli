import fs from "fs";
import path from "path";
import axios from "axios";
import yaml from "js-yaml";
import { isPostmanCollection } from "../server/postman";
import { enforceSpecPolicy } from "./policy";
import type { SpecFormat } from "./specs";

/**
 * Resolved spec ready to be written to disk and uploaded to Microcks.
 *
 *   `raw`     — original text content, written verbatim into specs/.
 *               Preserves YAML comments / formatting if the source
 *               was YAML.
 *   `parsed`  — JS-side representation, used to derive system name,
 *               vendor.json, etc.
 *   `format`  — openapi vs postman, drives the filename + ingestion.
 *   `filename`— what we should call the file inside specs/<system>/.
 *   `source`  — for logging only: "https://..." or "/local/path".
 */
export interface FetchedSpec {
  raw: string;
  parsed: unknown;
  format: SpecFormat;
  filename: string;
  source: string;
}

/** Cap the download size so a hostile / huge URL doesn't OOM us. */
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Download a spec from an HTTP(S) URL. Follows redirects, rejects
 * non-2xx, caps body at MAX_BYTES, and detects the format from
 * Content-Type when possible (with a content-sniff fallback).
 */
export async function fetchFromUrl(url: string): Promise<FetchedSpec> {
  let res;
  try {
    res = await axios.get<string>(url, {
      responseType: "text",
      transformResponse: [(d: unknown) => d as string], // disable axios JSON auto-parse
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      timeout: 15_000,
      headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
    });
  } catch (e) {
    const err = e as { code?: string; response?: { status?: number }; message?: string };
    const detail =
      err.response?.status !== undefined
        ? `HTTP ${err.response.status}`
        : err.code ?? err.message ?? "unknown error";
    throw new Error(`Failed to fetch ${url}: ${detail}`);
  }

  const contentType = String(res.headers["content-type"] ?? "");
  const urlExt = guessExt(url);
  const raw = String(res.data ?? "");

  return parseAndClassify(raw, { source: url, contentType, hintExt: urlExt });
}

/**
 * Read a spec from a local file path. Same parsing + classification
 * as the URL flow.
 */
export async function fetchFromFile(filePath: string): Promise<FetchedSpec> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > 10 MB limit).`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`${resolved} is not a regular file.`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const ext = path.extname(resolved).toLowerCase();
  return parseAndClassify(raw, { source: resolved, contentType: "", hintExt: ext });
}

interface ClassifyHints {
  source: string;
  contentType: string;
  hintExt: string;
}

function parseAndClassify(raw: string, hints: ClassifyHints): FetchedSpec {
  // Parse: try JSON first if the hints say so, else YAML (which also
  // parses JSON, since JSON is a subset of YAML).
  let parsed: unknown;
  const looksJson =
    hints.contentType.includes("json") ||
    hints.hintExt === ".json" ||
    /^\s*[{[]/.test(raw);

  try {
    parsed = looksJson ? JSON.parse(raw) : yaml.load(raw);
  } catch (e1) {
    // Fall through to the other parser before giving up.
    try {
      parsed = looksJson ? yaml.load(raw) : JSON.parse(raw);
    } catch {
      throw new Error(
        `Couldn't parse spec from ${hints.source} as JSON or YAML: ${(e1 as Error).message}`,
      );
    }
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `Spec from ${hints.source} parsed but isn't an object (got ${typeof parsed}).`,
    );
  }

  // Reject specs the rest of the pipeline can't handle (Postman scripts,
  // cookie-based auth, etc.) BEFORE writing anything to disk.
  enforceSpecPolicy(parsed, hints.source);

  if (isPostmanCollection(parsed)) {
    return {
      raw,
      parsed,
      format: "postman",
      filename: "collection.postman_collection.json",
      source: hints.source,
    };
  }

  // OpenAPI — pick a filename based on the original encoding so the
  // file on disk matches what the user gave us (yaml stays yaml).
  const filename = looksJson || hints.hintExt === ".json" ? "openapi.json" : "openapi.yaml";

  // Soft sanity check — we'll fail later in readSummary if title/version
  // are truly missing, but flag it now with a clearer source attribution.
  const info = (parsed as { info?: { title?: string; version?: string } }).info ?? {};
  if (!info.title || !info.version) {
    throw new Error(
      `Spec from ${hints.source} is missing info.title or info.version. ` +
        `OpenAPI specs need both to be ingested into Microcks.`,
    );
  }

  return {
    raw: looksJson ? raw : ensureYamlForm(raw, parsed),
    parsed,
    format: "openapi",
    filename,
    source: hints.source,
  };
}

/**
 * If a YAML-looking spec was actually delivered as JSON-in-YAML-clothing
 * (or has windows line endings, etc.), normalize. Otherwise pass through.
 */
function ensureYamlForm(raw: string, parsed: unknown): string {
  // If it parsed cleanly as YAML and ALSO parses cleanly as JSON,
  // pick the more human-friendly form by re-emitting YAML.
  if (/^\s*[{[]/.test(raw)) {
    try {
      return yaml.dump(parsed, { lineWidth: 120, noRefs: true });
    } catch {
      return raw;
    }
  }
  return raw;
}

function guessExt(urlOrPath: string): string {
  // Extract a path-like ending without query string / fragments.
  const stripped = urlOrPath.split(/[?#]/)[0] ?? "";
  const ext = path.extname(stripped).toLowerCase();
  return ext;
}
