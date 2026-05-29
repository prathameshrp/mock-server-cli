import fs from "fs";
import path from "path";
import kleur from "kleur";
import { confirm, input, select } from "@inquirer/prompts";
import { config, cliPrefix } from "../config";
import { log } from "../utils/logger";
import { fetchFromFile, fetchFromUrl, type FetchedSpec } from "../utils/fetch-spec";
import { deriveVendor } from "../utils/vendor-gen";
import { listSystems } from "../utils/specs";
import { addCommand } from "./add";

interface ImportOpts {
  fromUrl?: string;
  fromFile?: string;
  name?: string;
  yes?: boolean;
}

/**
 * Interactive bring-your-own-spec entry point.
 *
 * Three modes:
 *
 *   1. Fully interactive (`mock import`)
 *      → prompts for source (URL or file), then for system name,
 *        then offers to edit the auto-derived vendor.json.
 *
 *   2. Partially scripted (`mock import --from-url … --name …`)
 *      → no prompts; uses the flags. Useful in CI.
 *
 *   3. Edit-then-load (`mock import --from-file … --name … --yes`)
 *      → fully unattended; defaults for everything; useful when chaining.
 *
 * Either way the end state is the same:
 *
 *   specs/<name>/<filename>       — the spec verbatim
 *   specs/<name>/vendor.json      — auto-derived (overridable)
 *   Microcks loaded with it       — via the existing `mock add` path.
 */
export async function importCommand(opts: ImportOpts): Promise<void> {
  if (!isInteractiveCapable() && (!opts.fromUrl && !opts.fromFile)) {
    throw new Error(
      "Interactive prompts need a TTY. Re-run with --from-url <url> or --from-file <path>, " +
        "and optionally --name <system> --yes.",
    );
  }

  log.step("Importing a new spec");
  console.error("");

  const fetched = await resolveSource(opts);
  log.ok(`fetched (${formatSize(fetched.raw.length)})`);
  log.dim(`  format: ${fetched.format}`);
  log.dim(`  source: ${fetched.source}`);
  console.error("");

  const suggestedName = suggestSystemName(fetched, opts.name);
  const systemName = await resolveSystemName(suggestedName, opts);

  const targetDir = path.join(config.specsDir, systemName);
  if (fs.existsSync(targetDir)) {
    const ok = await confirmOverwrite(targetDir, opts);
    if (!ok) {
      log.warn("Aborted by user — nothing written.");
      return;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  const vendor = deriveVendor(fetched.parsed, systemName);
  printVendorPreview(vendor);

  if (!opts.yes && isInteractiveCapable()) {
    const edit = await confirm({
      message: "Edit the auto-derived vendor.json before writing?",
      default: false,
    });
    if (edit) {
      vendor.displayName =
        (await input({
          message: "displayName:",
          default: vendor.displayName,
        })) || vendor.displayName;
      vendor.auth.type = (await select({
        message: "auth.type:",
        choices: [
          { name: "none", value: "none" },
          { name: "apiKey", value: "apiKey" },
          { name: "bearer (HTTP)", value: "bearer" },
          { name: "oauth2", value: "oauth2" },
        ],
        default: vendor.auth.type,
      })) as typeof vendor.auth.type;
      if (vendor.auth.type === "oauth2") {
        const scopesRaw = await input({
          message: "auth.scopes (space-separated, optional):",
          default: (vendor.auth.scopes ?? []).join(" "),
        });
        const scopes = scopesRaw.split(/\s+/).filter(Boolean);
        if (scopes.length > 0) vendor.auth.scopes = scopes;
        else delete vendor.auth.scopes;
      } else {
        delete vendor.auth.scopes;
      }
    }
  }

  // Write specs/<name>/<filename> + vendor.json.
  fs.mkdirSync(targetDir, { recursive: true });
  const specPath = path.join(targetDir, fetched.filename);
  fs.writeFileSync(specPath, fetched.raw);
  const vendorJson = {
    displayName: vendor.displayName,
    auth: {
      type: vendor.auth.type,
      ...(vendor.auth.scopes ? { scopes: vendor.auth.scopes } : {}),
      ...(vendor.auth.notes ? { notes: vendor.auth.notes } : {}),
    },
  };
  fs.writeFileSync(
    path.join(targetDir, "vendor.json"),
    JSON.stringify(vendorJson, null, 2) + "\n",
  );

  console.error("");
  log.ok(`Wrote ${path.relative(process.cwd(), specPath)}`);
  log.ok(`Wrote ${path.relative(process.cwd(), path.join(targetDir, "vendor.json"))}`);
  console.error("");

  // Hand off to the existing add flow. If Microcks isn't running this
  // surfaces a clean error from there; the spec on disk is still good
  // for a later `mock add` after `mock up`.
  try {
    await addCommand(systemName);
  } catch (e) {
    log.warn(
      `Spec written to disk but Microcks upload failed: ${(e as Error).message}`,
    );
    log.dim(
      `Once the stack is up, just run \`${cliPrefix} add ${systemName}\` to finish.`,
    );
  }
}

/* ───────── helpers ───────── */

async function resolveSource(opts: ImportOpts): Promise<FetchedSpec> {
  if (opts.fromUrl) return fetchFromUrl(opts.fromUrl);
  if (opts.fromFile) return fetchFromFile(opts.fromFile);

  const sourceKind = await select({
    message: "Where's the spec?",
    choices: [
      { name: "Download from a URL", value: "url" },
      { name: "Pick a local file on disk", value: "file" },
    ],
  });

  if (sourceKind === "url") {
    const url = await input({
      message: "Spec URL:",
      validate: (v) => {
        if (!v) return "URL is required";
        try {
          const u = new URL(v);
          if (!/^https?:$/.test(u.protocol)) return "Only http:// and https:// URLs are supported";
          return true;
        } catch {
          return "Must be a valid URL";
        }
      },
    });
    return fetchFromUrl(url);
  }

  const filePath = await input({
    message: "Path to the spec file:",
    validate: (v) => {
      if (!v) return "Path is required";
      const resolved = path.resolve(v);
      if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
      if (!fs.statSync(resolved).isFile()) return `${resolved} is not a regular file`;
      return true;
    },
  });
  return fetchFromFile(filePath);
}

async function resolveSystemName(
  suggested: string,
  opts: ImportOpts,
): Promise<string> {
  if (opts.name) {
    if (!isValidSlug(opts.name)) {
      throw new Error(
        `--name "${opts.name}" must match /^[a-z0-9-]+$/. Try "${slugify(opts.name)}".`,
      );
    }
    return opts.name;
  }
  if (opts.yes) return suggested;
  return await input({
    message: "System name (used in /mock/<name>/...):",
    default: suggested,
    validate: (v) =>
      isValidSlug(v) ? true : "Lowercase letters, digits and dashes only.",
  });
}

async function confirmOverwrite(
  targetDir: string,
  opts: ImportOpts,
): Promise<boolean> {
  if (opts.yes) return true;
  if (!isInteractiveCapable()) {
    throw new Error(
      `${targetDir} already exists and no TTY available. Re-run with --yes to overwrite, or pick a different --name.`,
    );
  }
  return await confirm({
    message: `${path.relative(process.cwd(), targetDir)} already exists. Overwrite?`,
    default: false,
  });
}

function suggestSystemName(spec: FetchedSpec, override?: string): string {
  if (override && isValidSlug(override)) return override;
  const parsed = spec.parsed as { info?: { title?: string; name?: string } };
  const title = parsed.info?.title || parsed.info?.name;
  if (title) {
    const slug = slugify(title);
    if (slug && !taken(slug)) return slug;
    if (slug) return nextAvailable(slug);
  }
  return nextAvailable("imported-spec");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function isValidSlug(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
}

function taken(slug: string): boolean {
  return listSystems().includes(slug);
}

function nextAvailable(base: string): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const cand = `${base}-${i}`;
    if (!taken(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

function printVendorPreview(v: ReturnType<typeof deriveVendor>): void {
  log.step("Auto-derived vendor.json:");
  console.error(`  displayName : ${kleur.cyan(v.displayName)}`);
  console.error(`  auth.type   : ${kleur.cyan(v.auth.type)}`);
  if (v.auth.scopes && v.auth.scopes.length > 0) {
    console.error(`  auth.scopes : ${kleur.cyan(v.auth.scopes.join(", "))}`);
  }
  console.error(kleur.dim(`  (${v.rationale.join("; ")})`));
  console.error("");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isInteractiveCapable(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
