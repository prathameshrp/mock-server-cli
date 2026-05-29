#!/usr/bin/env tsx
import { Command } from "commander";
import { log } from "./utils/logger";
import { upCommand } from "./commands/up";
import { downCommand } from "./commands/down";
import { addCommand } from "./commands/add";
import { listCommand } from "./commands/list";
import { infoCommand } from "./commands/info";
import { removeCommand } from "./commands/remove";
import { serveCommand } from "./commands/serve";
import {
  tunnelUpCommand,
  tunnelDownCommand,
  tunnelStatusCommand,
  tunnelUrlCommand,
} from "./commands/tunnel";
import {
  createCommand,
  updateCommand,
  getCommand,
  deleteCommand,
  resetCommand,
} from "./commands/state";
import { resourcesCommand } from "./commands/resources";
import { tokenCommand } from "./commands/token";
import { initCommand } from "./commands/init";
import { syncCommand } from "./commands/sync";
import { importCommand } from "./commands/import";

// Read version from package.json at runtime so `npm version <bump>` is the
// single source of truth. Works in both dev (tsx, src/cli.ts) and prod
// (node, dist/cli.js) because package.json sits one directory up in both.
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("mock")
  .description(
    "Mock-server utility on top of Microcks: spin up a stack, ingest a spec, serve mocks, " +
      "manage stateful CRUD, and expose it through a Cloudflare quick tunnel.",
  )
  .version(pkg.version);

program
  .command("init")
  .description("Scaffold ./specs and ./data in the current directory (idempotent).")
  .action(safe(initCommand));

program
  .command("up")
  .description("Start the Microcks + mock-oauth2 containers.")
  .action(safe(upCommand));

program
  .command("down")
  .description("Stop the Microcks + mock-oauth2 containers.")
  .action(safe(downCommand));

program
  .command("add <system>")
  .description("Upload specs/<system>/* into Microcks (idempotent).")
  .action(safe(addCommand));

program
  .command("sync")
  .description("Upload every system under specs/* into Microcks (idempotent, tolerant). Used by the container entrypoint at boot.")
  .option("-q, --quiet", "only print failures and the summary")
  .action(safe(syncCommand));

program
  .command("import")
  .description("Bring your own spec: download from a URL or pick a local file, then ingest. Interactive by default.")
  .option("--from-url <url>", "skip the source prompt; fetch from this URL")
  .option("--from-file <path>", "skip the source prompt; read this local file")
  .option("--name <slug>", "system name to use (lowercase, dashes); defaults to a slug of the spec's info.title")
  .option("-y, --yes", "accept all defaults and the auto-derived vendor.json (no prompts)")
  .action(safe(importCommand));

program
  .command("remove <system>")
  .description("Remove a system's service from Microcks.")
  .action(safe(removeCommand));

program
  .command("list")
  .description("List configured systems and whether they're loaded into Microcks.")
  .action(safe(listCommand));

program
  .command("info <system>")
  .description("Print spec details, detected resources, security schemes, and the public URL.")
  .action(safe(infoCommand));

program
  .command("serve")
  .description("Start the HTTP gateway on :3000 (auth → stateful → Microcks).")
  .action(safe(serveCommand));

const tunnel = program
  .command("tunnel")
  .description("Manage a Cloudflare quick tunnel to your local gateway.");
tunnel
  .command("up")
  .description("Start `cloudflared tunnel --url http://localhost:3000` in the background.")
  .action(safe(tunnelUpCommand));
tunnel
  .command("down")
  .description("Kill the running tunnel and clear the recorded URL.")
  .action(safe(tunnelDownCommand));
tunnel
  .command("status")
  .description("Show whether a tunnel is running, with its URL.")
  .action(safe(tunnelStatusCommand));
tunnel
  .command("url")
  .description("Print the current tunnel URL (optionally with /mock/<system> appended).")
  .option("--raw", "Print just the URL, no trailing newline.")
  .option("--system <system>", "Append /mock/<system> to the URL.")
  .action(safe(tunnelUrlCommand));

program
  .command("create <system> <resource>")
  .description("Create a stateful entity in data/<system>.json (validates against the spec by default).")
  .option("--json <inline>", "Inline JSON payload.")
  .option("--file <path>", "Path to a JSON file.")
  .option(
    "--no-validate",
    "Skip JSON-schema validation of the payload. Useful for seeding fields the real API would compute server-side (ids, timestamps, derived flags).",
  )
  .action(safe(createCommand));

program
  .command("update <system> <resource> <id>")
  .description("Replace a stateful entity by id (validates against the spec by default).")
  .option("--json <inline>", "Inline JSON payload.")
  .option("--file <path>", "Path to a JSON file.")
  .option("--no-validate", "Skip JSON-schema validation of the payload.")
  .action(safe(updateCommand));

program
  .command("get <system> <resource> [id]")
  .description("Fetch a single entity by id, or list the collection if id is omitted.")
  .action(safe(getCommand));

program
  .command("delete <system> <resource> <id>")
  .description("Delete a stateful entity by id.")
  .action(safe(deleteCommand));

program
  .command("reset <system> [resource]")
  .description("Clear all stored data for a system, or just one resource.")
  .action(safe(resetCommand));

program
  .command("resources <system>")
  .description("List detected stateful resources and how many records are stored.")
  .action(safe(resourcesCommand));

program
  .command("token <system>")
  .description("Mint credentials matching the spec's auth scheme (Basic / Bearer / apiKey / OAuth2 JWT).")
  .option("--raw", "Print just the credential value(s), one per line, no narration.")
  .option("--header", "Print full Authorization (or apiKey) header lines.")
  .action(safe(tokenCommand));

program.parseAsync(process.argv).catch((err) => {
  log.err((err as Error).message);
  process.exitCode = 1;
});

/**
 * Wrap an async command so any thrown error is printed cleanly and the
 * process exits with code 1 — instead of an unhandled rejection trace
 * that buries the actual message.
 */
function safe<T extends unknown[]>(
  fn: (...args: T) => Promise<void> | void,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (err) {
      log.err((err as Error).message);
      process.exitCode = 1;
    }
  };
}
