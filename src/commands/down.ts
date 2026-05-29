import { log } from "../utils/logger";
import { config } from "../config";
import { ensureRuntimeAvailable, runCompose } from "../utils/docker";

export async function downCommand(): Promise<void> {
  const rt = ensureRuntimeAvailable();
  log.step(`Stopping mock stack with ${rt}…`);
  const result = runCompose(["down"], config.composeFile);
  if (result.status !== 0) {
    throw new Error(`\`${rt} compose down\` exited with code ${result.status}.`);
  }
  log.ok("Stack stopped.");
}
