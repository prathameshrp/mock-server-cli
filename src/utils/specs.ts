import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { config } from "../config";
import { isPostmanCollection, readPostmanSummary } from "../server/postman";
import { enforceSpecPolicy } from "./policy";

export type AuthType = "none" | "apiKey" | "bearer" | "oauth2";
export type SpecFormat = "openapi" | "postman";

export interface VendorMeta {
  displayName: string;
  auth: {
    type: AuthType;
    scopes?: string[];
    notes?: string;
  };
}

export interface OpenApiSummary {
  title: string;
  version: string;
}

export interface SystemSpec {
  system: string;
  specPath: string;
  format: SpecFormat;
  vendor: VendorMeta;
  openapi: OpenApiSummary;
}

const DEFAULT_VENDOR: VendorMeta = {
  displayName: "",
  auth: { type: "none" },
};

export function resolveSystemSpec(system: string): SystemSpec {
  const dir = path.join(config.specsDir, system);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No spec folder found at specs/${system}/. ` +
        `Create it and drop an openapi.yaml (or .json) and vendor.json inside.`,
    );
  }

  const specPath = findSpecFile(dir);
  if (!specPath) {
    throw new Error(
      `Found specs/${system}/ but no openapi.yaml / openapi.json / openapi.yml inside.`,
    );
  }

  const vendor = readVendorMeta(dir);
  if (!vendor.displayName) vendor.displayName = system;

  const { summary, format } = readSummary(specPath);

  return { system, specPath, format, vendor, openapi: summary };
}

export function listSystems(): string[] {
  if (!fs.existsSync(config.specsDir)) return [];
  return fs
    .readdirSync(config.specsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function findSpecFile(dir: string): string | null {
  // 1. Preferred names
  for (const name of ["openapi.yaml", "openapi.yml", "openapi.json"]) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  // 2. Otherwise fall back to the single YAML/JSON file in the folder.
  //    Lets users keep the vendor's original filename (e.g. yugabyte-platform.yaml).
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /\.(ya?ml|json)$/i.test(f) && f !== "vendor.json");
  if (candidates.length === 1) {
    return path.join(dir, candidates[0] as string);
  }
  if (candidates.length > 1) {
    throw new Error(
      `specs/${path.basename(dir)}/ has multiple spec candidates (${candidates.join(", ")}). ` +
        `Rename the right one to openapi.yaml so we know which to use.`,
    );
  }
  return null;
}

function readVendorMeta(dir: string): VendorMeta {
  const p = path.join(dir, "vendor.json");
  if (!fs.existsSync(p)) return { ...DEFAULT_VENDOR };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<VendorMeta>;
    return {
      displayName: raw.displayName ?? "",
      auth: {
        type: raw.auth?.type ?? "none",
        scopes: raw.auth?.scopes,
        notes: raw.auth?.notes,
      },
    };
  } catch (e) {
    throw new Error(`Failed to parse ${p}: ${(e as Error).message}`);
  }
}

function readSummary(specPath: string): { summary: OpenApiSummary; format: SpecFormat } {
  const raw = fs.readFileSync(specPath, "utf8");
  const parsed = (specPath.endsWith(".json")
    ? JSON.parse(raw)
    : yaml.load(raw)) as unknown;

  enforceSpecPolicy(parsed, path.relative(config.specsDir, specPath));

  if (isPostmanCollection(parsed)) {
    const { title, version } = readPostmanSummary(parsed);
    return { summary: { title, version }, format: "postman" };
  }

  const info = ((parsed as { info?: { title?: string; version?: string } } | null)?.info ?? {}) as {
    title?: string;
    version?: string;
  };
  if (!info.title || !info.version) {
    throw new Error(
      `Spec ${specPath} must have info.title and info.version (Microcks uses them to name the service). ` +
        `For Postman collections we read info.name + info.version automatically.`,
    );
  }
  return { summary: { title: info.title, version: info.version }, format: "openapi" };
}
