import { config, cliPrefix } from "../config";
import { MicrocksClient } from "../microcks/client";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";

/**
 * Upload a spec to Microcks. Idempotent: if a service with the same
 * (title, version) already exists, delete it first so the upload is a
 * clean replace.
 */
export async function addCommand(system: string): Promise<void> {
  log.step(`Adding system "${system}"…`);
  const spec = resolveSystemSpec(system);
  log.dim(
    `  spec:    ${spec.specPath} (${spec.format})\n` +
      `  title:   ${spec.openapi.title} v${spec.openapi.version}\n` +
      `  vendor:  ${spec.vendor.displayName} (auth: ${spec.vendor.auth.type})`,
  );

  const microcks = new MicrocksClient(config.microcksUrl);
  await microcks.waitUntilReady(10, 500).catch(() => {
    throw new Error(
      `Microcks at ${config.microcksUrl} isn't reachable. Run \`${cliPrefix} up\` first.`,
    );
  });

  const existing = await microcks.findService(
    spec.openapi.title,
    spec.openapi.version,
  );
  if (existing) {
    log.info(
      `Found existing service "${existing.name}" v${existing.version} (id=${existing.id}). Replacing…`,
    );
    await microcks.deleteService(existing.id);
  }

  await microcks.uploadArtifact(spec.specPath);
  log.ok(
    `Uploaded. Mock base URL: http://localhost:${config.serverPort}/mock/${system}`,
  );
  log.dim(
    `  Direct Microcks URL: ${config.microcksUrl}/rest/${encodeURIComponent(
      spec.openapi.title,
    )}/${encodeURIComponent(spec.openapi.version)}`,
  );
}
