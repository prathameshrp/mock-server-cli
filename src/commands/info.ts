import kleur from "kleur";
import { config, cliPrefix } from "../config";
import { MicrocksClient } from "../microcks/client";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";
import { detectResources } from "../server/resources";
import { getSchemesForInfo } from "../server/auth";
import { readState } from "../utils/state";

export async function infoCommand(system: string): Promise<void> {
  const spec = resolveSystemSpec(system);
  printSystemInfo(spec.system, spec);

  const microcks = new MicrocksClient(config.microcksUrl);
  let loaded = false;
  let opCount = 0;
  try {
    const svc = await microcks.findService(
      spec.openapi.title,
      spec.openapi.version,
    );
    if (svc) {
      loaded = true;
      opCount = svc.operations.length;
    }
  } catch {
    log.warn(`Microcks unreachable at ${config.microcksUrl}.`);
  }

  console.log(
    `${kleur.bold("  Microcks:")} ${
      loaded
        ? kleur.green(`loaded (${opCount} operations)`)
        : kleur.yellow(`not loaded — run \`${cliPrefix} add ${system}\``)
    }`,
  );

  const resources = detectResources(spec.specPath);
  if (resources.length > 0) {
    console.log(kleur.bold("  Detected resources:"));
    for (const r of resources) {
      const pag = formatPagination(r.pagination);
      const rhs = r.itemPath
        ? r.itemPath
        : kleur.dim("(list-only — no item endpoint)");
      console.log(
        `    • ${kleur.green(r.name)}  ${r.collectionPath}  ↔  ${rhs}${kleur.dim(pag)}`,
      );
    }
    console.log(kleur.dim(`    data file: data/${system}.json`));
  } else {
    console.log(kleur.dim("  No resources detected."));
  }

  const {
    securitySchemes,
    hasTopLevelSecurity,
    operationsWithSecurity,
    jwksUrl,
  } = getSchemesForInfo(spec.specPath);
  if (Object.keys(securitySchemes).length > 0) {
    console.log(kleur.bold("  Security schemes:"));
    let hasOauth = false;
    for (const [name, s] of Object.entries(securitySchemes)) {
      let descr = s.type;
      if (s.type === "http") descr += `/${s.scheme}`;
      if (s.type === "apiKey") descr += ` (${s.in}: ${s.name})`;
      if (s.type === "oauth2" || s.type === "openIdConnect") {
        hasOauth = true;
        const flows = Object.keys(s.flows ?? {});
        if (flows.length > 0) descr += ` [${flows.join(", ")}]`;
      }
      console.log(`    • ${kleur.cyan(name)}  ${descr}`);
    }

    // Where the spec's security lives, so the user can predict what
    // gets enforced on which endpoints.
    const sources: string[] = [];
    if (hasTopLevelSecurity) sources.push("top-level");
    if (operationsWithSecurity > 0)
      sources.push(`${operationsWithSecurity} per-operation`);
    if (sources.length === 0) {
      console.log(
        kleur.dim(
          "    (no `security` block anywhere — gateway will accept anything)",
        ),
      );
    } else {
      console.log(kleur.dim(`    enforcement: ${sources.join(" + ")}`));
    }

    if (hasOauth) {
      const gatewayBase = `http://localhost:${config.serverPort}/mock/${system}/oauth`;
      const internalBase = `${config.oauthUrl}/${system}`;
      console.log(kleur.bold("  OAuth2 endpoints (per-system issuer):"));
      console.log(
        `    • Discovery: ${kleur.cyan(`${gatewayBase}/.well-known/openid-configuration`)}`,
      );
      console.log(`    • Token    : ${kleur.cyan(`${gatewayBase}/token`)}`);
      console.log(`    • JWKS     : ${kleur.cyan(`${gatewayBase}/jwks`)}`);
      console.log(
        kleur.dim(
          `    Internal issuer (gateway verifies tokens against this): ${internalBase}`,
        ),
      );
      console.log(
        kleur.dim(
          `    Mint via CLI: \`${cliPrefix} token ${system} --raw\``,
        ),
      );
      // Reference the legacy /default JWKS only in passing — the
      // per-system path is what the gateway actually uses now.
      void jwksUrl;
    }
  }

  const state = readState();
  if (state.tunnel) {
    console.log(kleur.bold("  Public URL (tunnel):"));
    console.log(`    ${kleur.green(state.tunnel.url)}/mock/${system}/…`);
  }
}

function formatPagination(p: { style: string } & Record<string, unknown> | undefined): string {
  if (!p) return "";
  if (p["style"] === "page")
    return ` (page/${String(p["pageParam"])}+${String(p["sizeParam"])})`;
  if (p["style"] === "offset")
    return ` (offset/${String(p["offsetParam"])}+${String(p["limitParam"])})`;
  if (p["style"] === "cursor")
    return ` (cursor/${String(p["tokenParam"])}+${String(p["sizeParam"])})`;
  return "";
}

function printSystemInfo(
  system: string,
  spec: ReturnType<typeof resolveSystemSpec>,
): void {
  console.log("");
  console.log(`${kleur.bold("System:")} ${kleur.cyan(system)}`);
  console.log(`  Display name : ${spec.vendor.displayName}`);
  console.log(
    `  Spec         : ${spec.specPath.replace(process.cwd() + "/", "")} (${spec.format})`,
  );
  console.log(`  Title/Vers   : ${spec.openapi.title} v${spec.openapi.version}`);
  console.log(`  Declared auth: ${spec.vendor.auth.type}`);
  console.log(
    `  Base URL     : http://localhost:${config.serverPort}/mock/${system}`,
  );
}
