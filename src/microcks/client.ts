import fs from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";
import FormData from "form-data";

/**
 * Thin Microcks REST client. The Uber image we run has no auth (Keycloak
 * disabled in docker-compose), so we just hit /api/* directly.
 *
 * Endpoints used:
 *   POST /api/artifact/upload   — ingest an OpenAPI/Postman file
 *   GET  /api/services          — list services
 *   DELETE /api/services/:id    — remove a service
 */

export interface MicrocksOperation {
  name: string;
  method: string;
}

export interface MicrocksService {
  id: string;
  name: string;
  version: string;
  type: string;
  operations: MicrocksOperation[];
}

export class MicrocksClient {
  private http: AxiosInstance;

  constructor(private readonly baseUrl: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 30_000,
      validateStatus: () => true,
    });
  }

  async waitUntilReady(maxAttempts = 30, delayMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const r = await this.http.get("/api/services");
        if (r.status >= 200 && r.status < 500) return;
      } catch {
        /* keep polling */
      }
      await sleep(delayMs);
    }
    throw new Error(
      `Microcks at ${this.baseUrl} didn't become ready after ${maxAttempts} attempts.`,
    );
  }

  async uploadArtifact(specPath: string): Promise<string> {
    if (!fs.existsSync(specPath)) {
      throw new Error(`Spec file not found: ${specPath}`);
    }
    const form = new FormData();
    form.append("file", fs.createReadStream(specPath), {
      filename: path.basename(specPath),
    });

    const res = await this.http.post("/api/artifact/upload", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (res.status < 200 || res.status >= 300) {
      const detail =
        typeof res.data === "string"
          ? res.data
          : JSON.stringify(res.data ?? "");
      throw new Error(
        `Microcks artifact upload failed: Request failed with status code ${res.status} (HTTP ${res.status}) — ${detail}`,
      );
    }
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }

  async listServices(): Promise<MicrocksService[]> {
    const res = await this.http.get("/api/services");
    if (res.status !== 200) {
      throw new Error(`Microcks list services failed: HTTP ${res.status}`);
    }
    const raw = (res.data as unknown[]) ?? [];
    return raw.map((s) => normalizeService(s as Record<string, unknown>));
  }

  async findService(
    title: string,
    version: string,
  ): Promise<MicrocksService | null> {
    const services = await this.listServices();
    return (
      services.find((s) => s.name === title && s.version === version) ?? null
    );
  }

  async deleteService(id: string): Promise<void> {
    const res = await this.http.delete(`/api/services/${id}`);
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 404) return;
    throw new Error(`Microcks delete service failed: HTTP ${res.status}`);
  }
}

function normalizeService(raw: Record<string, unknown>): MicrocksService {
  const ops = Array.isArray(raw["operations"])
    ? (raw["operations"] as Record<string, unknown>[]).map((op) => ({
        name: String(op["name"] ?? ""),
        method: String(op["method"] ?? "").toUpperCase(),
      }))
    : [];
  return {
    id: String(raw["id"] ?? ""),
    name: String(raw["name"] ?? ""),
    version: String(raw["version"] ?? ""),
    type: String(raw["type"] ?? ""),
    operations: ops,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
