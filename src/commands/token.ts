import axios from "axios";
import kleur from "kleur";
import { decodeJwt } from "jose";
import { config, cliPrefix } from "../config";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";
import { getAuthExpectations } from "../server/auth";

interface TokenOpts {
  raw?: boolean;
  header?: boolean;
}

/**
 * Emit credentials matching the spec's declared auth scheme(s).
 *
 *   --raw     : print just the credential value (no narration), for shell capture
 *   --header  : print "Authorization: <scheme> <value>" lines (handy for `curl -H`)
 *   (default) : human-readable diagnostic with all schemes covered
 *
 * For OAuth2/openIdConnect schemes we hit the mock-oauth2-server's
 * client_credentials endpoint to get a real-looking JWT. For Basic/Bearer/
 * apiKey we synthesize obvious dummy values.
 */
export async function tokenCommand(
  system: string,
  opts: TokenOpts,
): Promise<void> {
  const spec = resolveSystemSpec(system);
  const requirements = getAuthExpectations(spec.specPath);
  const expectations = requirements.flat();

  if (expectations.length === 0) {
    log.warn(
      `${spec.openapi.title} declares no global "security" — the mock accepts anything. ` +
        `(Note: many specs declare security per-operation only; this CLI currently inspects only the top-level "security" block. Operation-level enforcement is on the gateway side once configured.)`,
    );
    return;
  }

  const out: string[] = [];

  for (const exp of expectations) {
    const s = exp.scheme;
    if (s.type === "http" && s.scheme === "basic") {
      const value = Buffer.from("mockuser:mockpass").toString("base64");
      out.push(formatLine(opts, "Authorization", `Basic ${value}`, "basic"));
    } else if (s.type === "http" && s.scheme === "bearer") {
      const token = "mock-bearer-" + Math.random().toString(36).slice(2, 10);
      out.push(formatLine(opts, "Authorization", `Bearer ${token}`, "bearer"));
    } else if (s.type === "oauth2" || s.type === "openIdConnect") {
      const jwt = await issueJwt(spec.vendor.auth.scopes, system);
      out.push(formatLine(opts, "Authorization", `Bearer ${jwt}`, "oauth2"));
    } else if (s.type === "apiKey") {
      const name = s.name ?? "X-API-Key";
      const value = "mock-key-" + Math.random().toString(36).slice(2, 10);
      out.push(formatLine(opts, name, value, `apiKey/${s.in}`));
    } else {
      log.warn(`Don't know how to issue a credential for scheme type "${s.type}".`);
    }
  }

  if (opts.raw) {
    // Just the value(s), one per line. Caller scripts use the first one.
    for (const line of out) {
      const colon = line.indexOf(": ");
      process.stdout.write((colon === -1 ? line : line.slice(colon + 2)) + "\n");
    }
    return;
  }

  if (opts.header) {
    for (const line of out) process.stdout.write(line + "\n");
    return;
  }

  console.log("");
  console.log(`${kleur.bold("Credentials for")} ${kleur.cyan(system)}:`);
  for (const line of out) console.log("  " + line);

  // Show JWT claims for OAuth2 tokens so users can sanity-check
  // scopes/expiry — most "403 insufficient_scope" failures are
  // diagnosable just by seeing what the token actually claims.
  const oauthLine = out.find((l) => l.includes("[oauth2]"));
  if (oauthLine) {
    const jwt = oauthLine.replace(/^.*Bearer\s+/, "").replace(/\s*\[.*$/, "");
    try {
      const claims = decodeJwt(jwt);
      console.log("");
      console.log(`${kleur.bold("JWT claims:")}`);
      console.log(
        `  iss     : ${claims.iss ?? "(unset)"}\n` +
          `  aud     : ${formatAud(claims.aud)}\n` +
          `  sub     : ${claims.sub ?? "(unset)"}\n` +
          `  scope   : ${(claims as Record<string, unknown>)["scope"] ?? "(none)"}\n` +
          `  exp     : ${formatTime(claims.exp)}\n` +
          `  iat     : ${formatTime(claims.iat)}`,
      );
      console.log(
        kleur.dim(
          `  signed by ${config.oauthUrl}/${system} — gateway verifies against ${config.oauthUrl}/${system}/jwks`,
        ),
      );
    } catch {
      // Decode failed — unusual, but don't break the command on it.
    }
  }

  console.log("");
  log.dim(
    `Use --raw to capture as $TOKEN, or --header to drop into \`curl -H "$(${cliPrefix === "mock" ? "mock" : "npm run mock --silent --"} token ${system} --header)"\`.`,
  );
}

function formatAud(aud: unknown): string {
  if (aud === undefined || aud === null) return "(unset)";
  if (Array.isArray(aud)) return aud.join(", ");
  return String(aud);
}

function formatTime(t: unknown): string {
  if (typeof t !== "number") return "(unset)";
  const d = new Date(t * 1000);
  const delta = Math.round((t * 1000 - Date.now()) / 1000);
  const rel = delta > 0 ? `in ${delta}s` : `${-delta}s ago`;
  return `${d.toISOString()} (${rel})`;
}

function formatLine(
  opts: TokenOpts,
  headerName: string,
  value: string,
  kind: string,
): string {
  if (opts.raw || opts.header) {
    return `${headerName}: ${value}`;
  }
  return `${kleur.cyan(headerName)}: ${value}    ${kleur.dim("[" + kind + "]")}`;
}

async function issueJwt(
  scopes?: string[],
  system?: string,
): Promise<string> {
  // Use the per-system issuer namespace if a system is supplied so the
  // resulting `iss` claim matches what the gateway verifies. The
  // mock-oauth2-server auto-creates the issuer on first hit.
  const issuer = system ? system : "default";
  const tokenUrl = `${config.oauthUrl}/${issuer}/token`;
  try {
    const res = await axios.post(
      tokenUrl,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "mock-client",
        client_secret: "mock-secret",
        scope: (scopes ?? []).join(" "),
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 5000,
      },
    );
    const tok = res.data?.access_token;
    if (typeof tok === "string" && tok.length > 0) return tok;
    throw new Error("OAuth response had no access_token");
  } catch (err) {
    const e = err as { code?: string; response?: { status?: number }; message?: string };
    const detail =
      e.response?.status !== undefined
        ? `HTTP ${e.response.status}`
        : e.code ?? e.message ?? "unknown error";
    throw new Error(
      `Failed to mint JWT from ${tokenUrl}: ${detail}. ` +
        `Is the OAuth server running? Try \`${cliPrefix} up\`.`,
    );
  }
}
