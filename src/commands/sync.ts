import kleur from "kleur";
import { config, cliPrefix } from "../config";
import { MicrocksClient } from "../microcks/client";
import { log } from "../utils/logger";
import { listSystems, resolveSystemSpec } from "../utils/specs";

/**
 * Bulk variant of `mock add`. Walks every system folder under specs/,
 * uploads each to Microcks, and reports a per-system summary. Designed
 * for two scenarios:
 *
 *   1. The container entrypoint on a deployed server — runs at boot,
 *      after Microcks is healthy, so every spec is loaded before the
 *      gateway starts taking traffic.
 *
 *   2. A developer running `mock sync` locally to bring their stack
 *      into sync after `git pull` or after dropping new specs in.
 *
 * Behaviour:
 *   - Idempotent: existing service+version is deleted before re-upload,
 *     so spec edits land cleanly.
 *   - Tolerant: a single bad spec doesn't fail the whole run. We track
 *     successes and failures and exit non-zero only if every system
 *     failed (so the container restarts cleanly on real outages, but
 *     accepts "9/10 specs loaded" as a viable state).
 *   - Slim output: one line per system. Use `mock add <system>` for the
 *     verbose, single-system flow.
 */
export async function syncCommand(options: { quiet?: boolean } = {}): Promise<void> {
  const systems = listSystems();
  if (systems.length === 0) {
    log.warn("No specs found under ./specs/. Nothing to sync.");
    log.dim(`Run \`${cliPrefix} init\` to scaffold, then drop a spec file in.`);
    return;
  }

  const microcks = new MicrocksClient(config.microcksUrl);
  await microcks.waitUntilReady(60, 1000).catch(() => {
    throw new Error(
      `Microcks at ${config.microcksUrl} isn't reachable after 60 attempts. Is the stack up?`,
    );
  });

  log.step(`Syncing ${systems.length} system(s) to Microcks at ${config.microcksUrl}…`);

  const results: { system: string; ok: boolean; detail: string }[] = [];
  for (const system of systems) {
    try {
      const spec = resolveSystemSpec(system);
      const existing = await microcks.findService(
        spec.openapi.title,
        spec.openapi.version,
      );
      if (existing) await microcks.deleteService(existing.id);
      await microcks.uploadArtifact(spec.specPath);
      results.push({
        system,
        ok: true,
        detail: `${spec.openapi.title} v${spec.openapi.version} [${spec.format}]`,
      });
      if (!options.quiet) {
        console.error(
          `  ${kleur.green("✓")} ${kleur.bold(system).padEnd(20)} ${kleur.dim(`${spec.openapi.title} v${spec.openapi.version} [${spec.format}]`)}`,
        );
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      results.push({ system, ok: false, detail: msg });
      console.error(
        `  ${kleur.red("✗")} ${kleur.bold(system).padEnd(20)} ${kleur.red(msg)}`,
      );
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.error("");
  if (failed === 0) {
    log.ok(`All ${ok} system(s) synced.`);
    return;
  }
  if (ok === 0) {
    log.err(`All ${failed} system(s) failed to sync. Check the messages above.`);
    process.exitCode = 1;
    return;
  }
  log.warn(`${ok} system(s) synced, ${failed} failed (see above).`);
  process.exitCode = 0;
}
