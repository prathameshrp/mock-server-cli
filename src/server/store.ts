import fs from "fs";
import path from "path";
import { config } from "../config";

type Entity = Record<string, unknown>;
type ResourceMap = Record<string, Entity>;
type StoreData = Record<string, ResourceMap>;

/**
 * One JSON-file-backed store per system. Layout on disk:
 *
 *   data/<system>.json
 *   {
 *     "<resource>": {
 *       "<id>": { ...entity },
 *       ...
 *     }
 *   }
 *
 * Every read goes to disk (via mtime check) so the in-process HTTP server
 * and the CLI commands stay in sync without coordination.
 */
export class SystemStore {
  private data: StoreData = {};
  private loadedMtime = -1;

  constructor(private readonly filePath: string) {}

  list(resource: string): Entity[] {
    this.maybeReload();
    return Object.values(this.data[resource] ?? {});
  }

  get(resource: string, id: string): Entity | undefined {
    this.maybeReload();
    return this.data[resource]?.[id];
  }

  put(resource: string, id: string, entity: Entity): Entity {
    this.maybeReload();
    if (!this.data[resource]) this.data[resource] = {};
    this.data[resource][id] = entity;
    this.save();
    return entity;
  }

  delete(resource: string, id: string): boolean {
    this.maybeReload();
    const bucket = this.data[resource];
    if (!bucket || !(id in bucket)) return false;
    delete bucket[id];
    this.save();
    return true;
  }

  count(resource: string): number {
    this.maybeReload();
    return Object.keys(this.data[resource] ?? {}).length;
  }

  summary(): Record<string, number> {
    this.maybeReload();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.data)) {
      out[k] = Object.keys(v).length;
    }
    return out;
  }

  reset(): void {
    this.data = {};
    this.save();
  }

  resetResource(resource: string): boolean {
    this.maybeReload();
    if (!this.data[resource]) return false;
    delete this.data[resource];
    this.save();
    return true;
  }

  private maybeReload(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        if (this.loadedMtime !== 0) {
          this.data = {};
          this.loadedMtime = 0;
        }
        return;
      }
      const mtime = fs.statSync(this.filePath).mtimeMs;
      if (mtime === this.loadedMtime) return;
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.data = raw.trim() ? (JSON.parse(raw) as StoreData) : {};
      this.loadedMtime = mtime;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    try {
      this.loadedMtime = fs.statSync(this.filePath).mtimeMs;
    } catch {
      this.loadedMtime = -1;
    }
  }
}

const stores = new Map<string, SystemStore>();

export function getStore(system: string): SystemStore {
  let s = stores.get(system);
  if (!s) {
    s = new SystemStore(path.join(config.dataDir, `${system}.json`));
    stores.set(system, s);
  }
  return s;
}
