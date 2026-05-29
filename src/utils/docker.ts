import { spawnSync, SpawnSyncReturns } from "child_process";

/**
 * Container runtime abstraction. We support both Docker and Podman
 * because some folks (and CI sandboxes) only have one or the other.
 *
 * The CLI auto-detects which is on PATH and uses `<runtime> compose ...`
 * for everything. We prefer Podman if both are present to avoid Docker
 * Desktop licensing surprises, but `MOCK_RUNTIME` env var overrides.
 */

export type Runtime = "docker" | "podman";

export function detectRuntime(): Runtime | null {
  const forced = process.env.MOCK_RUNTIME?.toLowerCase();
  if (forced === "docker" || forced === "podman") {
    return whichOk(forced) ? forced : null;
  }
  if (whichOk("podman")) return "podman";
  if (whichOk("docker")) return "docker";
  return null;
}

function whichOk(cmd: string): boolean {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export function ensureRuntimeReady(rt: Runtime): void {
  if (rt === "podman") {
    const r = spawnSync("podman", ["machine", "list", "--format", "{{.Running}}"], {
      encoding: "utf8",
    });
    if (r.status === 0 && /true/i.test(r.stdout)) return;
    if (r.status === 0 && r.stdout.trim().length === 0) {
      // No machines defined; assume native (Linux). Try a benign ping.
      const p = spawnSync("podman", ["info", "--format", "{{.Host.OS}}"], {
        encoding: "utf8",
      });
      if (p.status === 0) return;
      throw new Error(
        "Podman is installed but `podman info` failed. On macOS, run `podman machine init && podman machine start` first.",
      );
    }
    throw new Error(
      "Podman is installed but no machine is running. Run: `podman machine start` (or `podman machine init` if you haven't created one).",
    );
  }
  // docker: assume the daemon socket is reachable; spawnSync of compose will surface a clear error otherwise.
}

export function ensureRuntimeAvailable(): Runtime {
  const rt = detectRuntime();
  if (!rt) {
    throw new Error(
      "No container runtime found on PATH. Install one of:\n" +
        "  • Podman:   brew install podman podman-compose && podman machine init && podman machine start\n" +
        "  • OrbStack: brew install --cask orbstack\n" +
        "  • Docker:   https://www.docker.com/get-started",
    );
  }
  ensureRuntimeReady(rt);
  return rt;
}

/**
 * Run `<runtime> compose <args>` and inherit stdio so the user sees progress.
 * Returns the exit code.
 *
 * When `composeFile` is provided we pass it via `-f <path>`, which lets the
 * packaged CLI work from any CWD — the docker-compose.yml lives inside
 * the installed package, not next to wherever the user happens to be.
 */
export function runCompose(
  args: string[],
  composeFile?: string,
): SpawnSyncReturns<string> {
  const rt = ensureRuntimeAvailable();
  const prefix: string[] = composeFile
    ? ["compose", "-f", composeFile]
    : ["compose"];
  return spawnSync(rt, [...prefix, ...args], {
    stdio: "inherit",
    encoding: "utf8",
  });
}

export function runtimeLabel(): Runtime {
  return ensureRuntimeAvailable();
}
