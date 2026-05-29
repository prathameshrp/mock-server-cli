import fs from "fs";
import path from "path";
import kleur from "kleur";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";
import { detectResources } from "../server/resources";
import { getStore } from "../server/store";
import { validateRequestBody } from "../server/validation";

/**
 * CLI counterparts to the HTTP CRUD endpoints. They go through the same
 * SystemStore (which is mtime-aware), so changes here are visible to a
 * running `mock serve` immediately and vice-versa.
 */

interface PayloadOpts {
  json?: string;
  file?: string;
  // Commander defines `--no-validate` as opts.validate (default true; false when flag is passed).
  validate?: boolean;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function missingPayloadMessage(): string {
  const base = "Pass --json '<inline>' or --file <path.json>.";
  const argv = process.argv.slice(2);
  const looksLikeJson = argv.find(
    (a) => typeof a === "string" && /^\s*[\[{]/.test(a),
  );
  if (!looksLikeJson) return base;

  const underNpm = !!process.env.npm_lifecycle_event;
  if (!underNpm) {
    return (
      `${base}\n  (Found a JSON-looking positional argument ${kleur.gray(truncate(looksLikeJson, 60))} ` +
      `but no --json flag. Did you forget to write \`--json '...'\`?)`
    );
  }

  return [
    "It looks like npm consumed your --json flag.",
    "",
    "Re-run with `--` between the script and the subcommand args so npm forwards everything verbatim:",
    "",
    "  npm run mock -- create <system> <resource> --json '...'",
    "",
    "Or use the packaged binary directly (no `--` needed):",
    "",
    "  mock create <system> <resource> --json '...'",
    "",
    `(npm 7+ owns the --json flag itself; without \`--\` it strips it from your command before tsx ever sees it. Your JSON payload ${kleur.gray(truncate(looksLikeJson, 60))} was left as a stray positional.)`,
  ].join("\n");
}

function readPayload(opts: PayloadOpts): Record<string, unknown> {
  let raw: string;
  if (opts.json) {
    raw = opts.json;
  } else if (opts.file) {
    raw = fs.readFileSync(path.resolve(opts.file), "utf8");
  } else {
    throw new Error(missingPayloadMessage());
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Payload is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function findResource(system: string, resource: string) {
  const spec = resolveSystemSpec(system);
  const resources = detectResources(spec.specPath);
  const def = resources.find((r) => r.name === resource);
  if (!def) {
    const known = resources.map((r) => r.name).join(", ") || "(none)";
    throw new Error(
      `No stateful resource "${resource}" found in spec for ${system}. Known: ${known}.`,
    );
  }
  if (!def.itemPath || !def.idParam) {
    throw new Error(
      `Resource "${resource}" in ${system} is list-only (no item endpoint declared in the spec) — ` +
        `it doesn't support create/update/get-by-id/delete. The list endpoint serves the spec's example collection through the gateway.`,
    );
  }
  return { spec, def: def as Required<Pick<typeof def, "itemPath" | "idParam">> & typeof def };
}

export async function createCommand(
  system: string,
  resource: string,
  opts: PayloadOpts,
): Promise<void> {
  const { spec, def } = findResource(system, resource);
  const payload = readPayload(opts);
  if (opts.validate !== false) {
    const v = validateRequestBody(spec.specPath, def, "POST", payload);
    if (!v.ok) {
      log.err("Payload failed validation against the spec:");
      for (const e of v.errors ?? []) log.dim(`  - ${e}`);
      log.dim(
        "  (This is a mock — if you want to seed extra fields that the real API would compute server-side, re-run with --no-validate.)",
      );
      process.exitCode = 1;
      return;
    }
  }
  const store = getStore(system);
  const id = String(payload[def.idParam] ?? crypto.randomUUID().slice(0, 12));
  const entity = { ...payload, [def.idParam]: id };
  store.put(def.name, id, entity);
  process.stdout.write(JSON.stringify(entity, null, 2) + "\n");
  log.ok(`Created ${resource}/${id} in data/${system}.json`);
}

export async function updateCommand(
  system: string,
  resource: string,
  id: string,
  opts: PayloadOpts,
): Promise<void> {
  const { spec, def } = findResource(system, resource);
  const payload = readPayload(opts);
  if (opts.validate !== false) {
    const v = validateRequestBody(spec.specPath, def, "PUT", payload);
    if (!v.ok) {
      log.err("Payload failed validation against the spec:");
      for (const e of v.errors ?? []) log.dim(`  - ${e}`);
      log.dim("  (Re-run with --no-validate to seed extra fields.)");
      process.exitCode = 1;
      return;
    }
  }
  const store = getStore(system);
  const entity = { ...payload, [def.idParam]: id };
  store.put(def.name, id, entity);
  process.stdout.write(JSON.stringify(entity, null, 2) + "\n");
  log.ok(`Updated ${resource}/${id} in data/${system}.json`);
}

export async function getCommand(
  system: string,
  resource: string,
  id?: string,
): Promise<void> {
  const { def } = findResource(system, resource);
  const store = getStore(system);
  if (id) {
    const entity = store.get(def.name, id);
    if (!entity) {
      process.stderr.write(`No ${resource}/${id}.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(entity, null, 2) + "\n");
    return;
  }
  const items = store.list(def.name);
  process.stdout.write(JSON.stringify(items, null, 2) + "\n");
  log.ok(`${items.length} ${resource} record(s).`);
}

export async function deleteCommand(
  system: string,
  resource: string,
  id: string,
): Promise<void> {
  const { def } = findResource(system, resource);
  const store = getStore(system);
  const ok = store.delete(def.name, id);
  if (!ok) {
    process.stderr.write(`No ${resource}/${id}.\n`);
    process.exitCode = 1;
    return;
  }
  log.ok(`Deleted ${resource}/${id}.`);
}

export async function resetCommand(
  system: string,
  resource?: string,
): Promise<void> {
  resolveSystemSpec(system); // surface "no such system" early
  const store = getStore(system);
  if (resource) {
    const cleared = store.resetResource(resource);
    if (!cleared) {
      log.warn(`No data for ${resource} in ${system}.`);
      return;
    }
    log.ok(`Cleared ${resource} for ${system}.`);
    return;
  }
  store.reset();
  log.ok(`Cleared all stored data for ${system}.`);
}

const crypto = require("crypto") as typeof import("crypto");
