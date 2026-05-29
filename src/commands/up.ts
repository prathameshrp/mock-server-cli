import fs from "fs";
import { spawnSync } from "child_process";
import { log } from "../utils/logger";
import { config } from "../config";
import { ensureRuntimeAvailable, runCompose } from "../utils/docker";
import { MicrocksClient } from "../microcks/client";

export async function upCommand(): Promise<void> {
  if (!fs.existsSync(config.composeFile)) {
    throw new Error(
      `docker-compose.yml not found at ${config.composeFile}. ` +
        `If you installed via \`npm link\` the package layout may have changed — try \`npm run build && npm link\` again.`,
    );
  }
  const rt = ensureRuntimeAvailable();
  log.step(`Starting mock stack with ${rt}…`);
  log.dim(`compose file: ${config.composeFile}`);

  const result = runCompose(["up", "-d"], config.composeFile);
  if (result.status !== 0) {
    throw new Error(`\`${rt} compose up -d\` exited with code ${result.status}.`);
  }

  log.info("Waiting for Microcks to come online…");
  const microcks = new MicrocksClient(config.microcksUrl);
  await microcks.waitUntilReady(60, 1000);
  log.ok(`Microcks ready at ${config.microcksUrl}`);
  log.ok(`OAuth server at ${config.oauthUrl}`);

  // Probe the oauth server too; failure is non-fatal.
  const p = spawnSync("curl", ["-sfo", "/dev/null", `${config.oauthUrl}/default/.well-known/openid-configuration`]);
  if (p.status !== 0) {
    log.warn("OAuth server didn't answer yet — give it a few seconds.");
  }
}
