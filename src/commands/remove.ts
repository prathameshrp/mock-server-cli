import { config } from "../config";
import { MicrocksClient } from "../microcks/client";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";

export async function removeCommand(system: string): Promise<void> {
  const spec = resolveSystemSpec(system);
  const microcks = new MicrocksClient(config.microcksUrl);
  const svc = await microcks.findService(spec.openapi.title, spec.openapi.version);
  if (!svc) {
    log.warn(
      `No Microcks service "${spec.openapi.title}" v${spec.openapi.version} found — nothing to remove.`,
    );
    return;
  }
  await microcks.deleteService(svc.id);
  log.ok(`Removed ${spec.openapi.title} v${spec.openapi.version} from Microcks.`);
}
