import fs from "fs";
import { config, ensureStateDir } from "../config";

/**
 * Tiny JSON-file state for the CLI's own bookkeeping (tunnel PID/URL, etc).
 * Per-system data lives in data/<system>.json (see server/store.ts), not here.
 */

export interface TunnelState {
  url: string;
  pid: number;
  logFile: string;
  startedAt: string;
}

export interface MockState {
  tunnel?: TunnelState;
}

export function readState(): MockState {
  try {
    if (!fs.existsSync(config.stateFile)) return {};
    const raw = fs.readFileSync(config.stateFile, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as MockState;
  } catch {
    return {};
  }
}

export function writeState(state: MockState): void {
  ensureStateDir();
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

export function clearTunnel(): void {
  const s = readState();
  delete s.tunnel;
  writeState(s);
}
