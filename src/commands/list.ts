import kleur from "kleur";
import { config, cliPrefix } from "../config";
import { MicrocksClient, MicrocksService } from "../microcks/client";
import { log } from "../utils/logger";
import { listSystems, resolveSystemSpec } from "../utils/specs";

export async function listCommand(): Promise<void> {
  const systems = listSystems();
  if (systems.length === 0) {
    log.warn("No specs found under ./specs/.");
    log.dim(`  Drop one in (specs/<system>/openapi.yaml or *.postman_collection.json) and run \`${cliPrefix} add <system>\`. Or run \`${cliPrefix} init\` to scaffold the workspace.`);
    return;
  }

  const microcks = new MicrocksClient(config.microcksUrl);
  let services: MicrocksService[] = [];
  try {
    services = await microcks.listServices();
  } catch {
    log.warn(`Couldn't reach Microcks at ${config.microcksUrl} (the stack may be down).`);
  }

  log.step("Available systems:");
  for (const system of systems) {
    let title = "?";
    let version = "?";
    let format = "?";
    let loaded = false;
    try {
      const spec = resolveSystemSpec(system);
      title = spec.openapi.title;
      version = spec.openapi.version;
      format = spec.format;
      loaded = services.some(
        (s) => s.name === title && s.version === version,
      );
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      log.err(`  ${kleur.bold(system)} — ${msg}`);
      continue;
    }
    const status = loaded
      ? kleur.green("loaded ")
      : kleur.gray("not loaded");
    console.log(
      `  ${kleur.bold(system).padEnd(20)} ${status}  ${kleur.dim(`${title} v${version}`)}  ${kleur.dim(`[${format}]`)}`,
    );
  }
  console.log("");
  log.dim(`Base URL: http://localhost:${config.serverPort}/mock/<system>/…`);
}
