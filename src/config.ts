import fs from "fs";
import os from "os";
import path from "path";

/**
 * Path resolution for the packaged CLI.
 *
 * Three categories:
 *
 *   1. Per-project (specs/, data/) — anchored to the user's current
 *      working directory. So each repo can have its own mocks. Override
 *      via the `MOCK_HOME` env var.
 *
 *   2. Per-user (.mock-state.json, .mock-tunnel.log) — anchored to
 *      `~/.mock-server-automation/`. A Cloudflare tunnel is a global
 *      resource (one cloudflared process / one URL per machine), so its
 *      state should be visible no matter which directory you're in.
 *      Override via the `MOCK_STATE_DIR` env var.
 *
 *   3. Package-bundled (docker-compose.yml) — shipped inside the
 *      installed package. Resolved relative to this file, not CWD.
 *      During development (running from src/) the layout is
 *      `<repo>/src/config.ts` → `<repo>/docker-compose.yml`, two levels
 *      up. After build (running from dist/) it's the same shape:
 *      `<pkg>/dist/config.js` → `<pkg>/docker-compose.yml`.
 *      We also fall back to walking parent directories in case future
 *      restructuring changes the layout.
 *
 * Networky defaults come from env vars (MICROCKS_URL / OAUTH_URL / PORT)
 * with sensible fallbacks for the bundled docker-compose setup.
 */

const mockHome = resolveProjectHome();
const stateDir = resolveStateDir();

/**
 * How users invoke this CLI in their current environment. When running
 * via `npm run mock -- <cmd>` (development from the repo) we keep the
 * `npm run` prefix in hints; otherwise (packaged install) we just say
 * `mock <cmd>`. Used purely for user-facing strings.
 */
export const cliPrefix: string = process.env["npm_lifecycle_event"]
  ? "npm run mock --"
  : "mock";

export const config = {
  /** Where `specs/<system>/<spec-file>` lives. CWD-based by default. */
  specsDir: path.join(mockHome, "specs"),
  /** Where per-system stateful records live. CWD-based by default. */
  dataDir: path.join(mockHome, "data"),
  /** Tunnel state — global, in the user's home. */
  stateFile: path.join(stateDir, "state.json"),
  /** Cloudflared log file — global, in the user's home. */
  tunnelLogFile: path.join(stateDir, "tunnel.log"),
  /** The docker-compose file bundled inside the package. */
  composeFile: resolveBundledComposeFile(),
  /** Where the CLI thinks the project root is (used by `mock init`). */
  mockHome,
  /** Where global state lives. */
  stateDir,

  microcksUrl: process.env["MICROCKS_URL"] ?? "http://localhost:8585",
  oauthUrl: process.env["OAUTH_URL"] ?? "http://localhost:8181",
  serverPort: Number.parseInt(process.env["PORT"] ?? "3000", 10),

  /**
   * When set (e.g. `https://mocks.example.com`), the gateway uses this
   * instead of the request's host header when constructing paginated
   * `next_page` URLs. Required behind a reverse proxy that rewrites Host.
   */
  publicBaseUrl: resolvePublicBaseUrl(),

  /**
   * Tells Express to honour X-Forwarded-* headers when computing
   * req.protocol / req.host / req.ip. Defaults to true in containers
   * (so the prod stack with Caddy in front works out of the box), or
   * when explicitly enabled via TRUST_PROXY=1.
   */
  trustProxy: resolveTrustProxy(),
};

function resolvePublicBaseUrl(): string | undefined {
  const raw = process.env["PUBLIC_BASE_URL"];
  if (!raw || raw.trim().length === 0) return undefined;
  return raw.replace(/\/+$/, "");
}

function resolveTrustProxy(): boolean {
  const raw = process.env["TRUST_PROXY"];
  if (raw === undefined) {
    // Auto-on when the process is in a container with a public base URL
    // configured — almost always means there's a reverse proxy in front.
    return Boolean(process.env["PUBLIC_BASE_URL"]);
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function resolveProjectHome(): string {
  const override = process.env["MOCK_HOME"];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return process.cwd();
}

function resolveStateDir(): string {
  const override = process.env["MOCK_STATE_DIR"];
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".mock-server-automation");
}

/**
 * Lazily create the state directory the first time someone is about to
 * write into it. Keeping this out of module load means commands that
 * never touch state (like `mock --help`) succeed even if the user
 * can't write to `~/.mock-server-automation`.
 */
export function ensureStateDir(): string {
  fs.mkdirSync(config.stateDir, { recursive: true });
  return config.stateDir;
}

function resolveBundledComposeFile(): string {
  // From src/config.ts or dist/config.js, the bundled compose file is one
  // directory up. Try that first; otherwise walk parents looking for a
  // docker-compose.yml that sits next to a package.json identifying us
  // as this package.
  const direct = path.resolve(__dirname, "..", "docker-compose.yml");
  if (fs.existsSync(direct)) return direct;

  let dir = path.resolve(__dirname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "docker-compose.yml");
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(candidate) && fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as {
          name?: string;
        };
        if (parsed.name === "mock-server-automation") return candidate;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort — return the direct path. up/down commands will surface
  // a clean error if it doesn't exist.
  return direct;
}
