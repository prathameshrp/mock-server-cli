import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import kleur from "kleur";
import { confirm } from "@inquirer/prompts";
import { config, cliPrefix, ensureStateDir } from "../config";
import { log } from "../utils/logger";
import { readState, writeState, clearTunnel } from "../utils/state";

/**
 * Cloudflare quick tunnel manager. We spawn `cloudflared tunnel --url
 * http://localhost:<port>` in detached mode, tail its stderr to pick up
 * the generated *.trycloudflare.com URL, and remember pid + url in
 * .mock-state.json so subsequent `tunnel status` / `tunnel url` /
 * `tunnel down` calls work across CLI invocations.
 */

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function tunnelUpCommand(): Promise<void> {
  if (!hasCloudflared()) {
    throw new Error(
      "`cloudflared` isn't on PATH. Install it first:\n" +
        "  brew install cloudflared\n" +
        "Or grab the binary from https://github.com/cloudflare/cloudflared/releases.",
    );
  }

  const existing = readState().tunnel;
  if (existing && isAlive(existing.pid)) {
    log.warn(`A tunnel is already running (pid=${existing.pid}).`);
    log.info(`URL: ${existing.url}`);
    log.dim(`Run \`${cliPrefix} tunnel down\` first if you want a new one.`);
    return;
  }

  printQuickTunnelSecurityBanner();
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const proceed = await confirm({
      message: "Acknowledge the above and continue?",
      default: true,
    });
    if (!proceed) {
      log.info("Aborted.");
      return;
    }
  }

  log.step("Starting Cloudflare quick tunnel…");
  ensureStateDir();
  fs.writeFileSync(config.tunnelLogFile, "");
  const out = fs.openSync(config.tunnelLogFile, "a");
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${config.serverPort}`],
    {
      detached: true,
      stdio: ["ignore", out, out],
    },
  );
  child.unref();
  log.dim(`  cloudflared pid=${child.pid}, logs: ${config.tunnelLogFile}`);

  const url = await waitForTunnelUrl(config.tunnelLogFile, 30_000);
  if (!url) {
    throw new Error(
      "Tunnel started but no *.trycloudflare.com URL appeared within 30s. " +
        `Check ${config.tunnelLogFile} for what cloudflared said.`,
    );
  }

  writeState({
    tunnel: {
      pid: child.pid!,
      url,
      logFile: config.tunnelLogFile,
      startedAt: new Date().toISOString(),
    },
  });

  log.ok(`Tunnel up: ${url}`);
  log.dim(`  Use ${url}/mock/<system>/… as your public base URL.`);
}

export async function tunnelDownCommand(): Promise<void> {
  const state = readState();
  if (!state.tunnel) {
    log.warn("No tunnel recorded in .mock-state.json.");
    return;
  }
  const { pid, url } = state.tunnel;
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      // tiny grace period for clean shutdown
      await new Promise((r) => setTimeout(r, 300));
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
      log.ok(`Killed cloudflared pid=${pid} (was at ${url}).`);
    } catch (e) {
      log.warn(`Tried to kill pid=${pid} but failed: ${(e as Error).message}`);
    }
  } else {
    log.info(`Cloudflared pid=${pid} was already dead.`);
  }
  clearTunnel();
}

export async function tunnelStatusCommand(): Promise<void> {
  const state = readState();
  if (!state.tunnel) {
    console.log(`No tunnel running. Start one with \`${cliPrefix} tunnel up\`.`);
    return;
  }
  const { pid, url, startedAt, logFile } = state.tunnel;
  const alive = isAlive(pid);
  console.log(`pid       : ${pid}  (${alive ? "alive" : "DEAD"})`);
  console.log(`url       : ${url}`);
  console.log(`started   : ${startedAt}`);
  console.log(`log file  : ${logFile}`);
  if (!alive) {
    console.log("");
    console.log(
      "The cloudflared process is gone but the state file still references it. " +
        `Run \`${cliPrefix} tunnel down\` to clean it up, then \`tunnel up\` to start fresh.`,
    );
  }
}

export async function tunnelUrlCommand(opts: {
  raw?: boolean;
  system?: string;
}): Promise<void> {
  const state = readState();
  if (!state.tunnel) {
    process.stderr.write("No tunnel running.\n");
    process.exitCode = 1;
    return;
  }
  let url = state.tunnel.url;
  if (opts.system) url = `${url}/mock/${opts.system}`;
  if (opts.raw) process.stdout.write(url);
  else process.stdout.write(url + "\n");
}

/* ─── helpers ─── */

/**
 * Prints a high-visibility warning before we spawn cloudflared. Quick Tunnels
 * are anonymous, public, and explicitly dev/demo-only per Cloudflare's ToS;
 * we want users to actively think before exposing any mock that mirrors
 * production-shaped data, tokens, or API contracts.
 */
function printQuickTunnelSecurityBanner(): void {
  const INNER = 78; // visible width between the two side border chars
  const horiz = "─".repeat(INNER);
  const top = `╭${horiz}╮`;
  const bottom = `╰${horiz}╯`;
  const side = "│";

  const yellow = kleur.yellow().bold;
  const red = kleur.red().bold;
  const dim = kleur.gray;

  const pad = (raw: string): string =>
    " " + raw + " ".repeat(Math.max(0, INNER - 1 - raw.length));
  const row = (raw: string, color?: (s: string) => string): string => {
    const padded = pad(raw);
    const body = color ? color(padded) : padded;
    return `${yellow(side)}${body}${yellow(side)}`;
  };

  const lines: string[] = [
    yellow(top),
    row("⚠  SECURITY WARNING — Cloudflare Quick Tunnel", red),
    row(""),
    row("Creates an ANONYMOUS, PUBLIC URL (*.trycloudflare.com) reachable by"),
    row("anyone on the internet who has (or guesses) the URL. Cloudflare's ToS"),
    row("marks Quick Tunnels as ephemeral dev/demo only — NOT for production or"),
    row("sustained use."),
    row(""),
    row("Do NOT tunnel mocks that mirror real user data, real customer IDs,"),
    row("real OAuth tokens, or production-shaped corporate API contracts."),
    row(""),
    row("Corporate security policies often treat ad-hoc tunnels (ngrok,"),
    row("cloudflared quick tunnels, etc.) as a data-exfiltration vector and may"),
    row("audit, alert on, or block this traffic."),
    row(""),
    row("Safer alternatives:", red),
    row("  • Cloudflare Named Tunnel + Zero Trust Access (auth-gated, stable"),
    row("    URL, free tier — requires a domain you control)"),
    row("  • Deploy via docker-compose.prod.yml on a VPS (24/7 stable URL,"),
    row("    see docs/06-deployment.md)"),
    row("  • SSH reverse tunnel through a corporate bastion (no new vendors,"),
    row("    reuses existing corp SSO / SSH)"),
    yellow(bottom),
  ];

  for (const ln of lines) console.error(ln);
  console.error(dim("  (banner shown once per `tunnel up` invocation)"));
}

function hasCloudflared(): boolean {
  const r = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForTunnelUrl(
  logFile: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = 0;
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > lastSize) {
        const text = fs.readFileSync(logFile, "utf8");
        const m = text.match(URL_REGEX);
        if (m && m[0]) return m[0];
        lastSize = stat.size;
      }
    } catch {
      /* file may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Silence unused path import warning (it's currently unused but kept for future log redirection).
export const _unused = path;
