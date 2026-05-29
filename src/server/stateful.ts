import crypto from "crypto";
import { Request, Response } from "express";
import { config } from "../config";
import { SystemSpec } from "../utils/specs";
import {
  detectResources,
  matchResource,
  PaginationDef,
  ResourceDef,
} from "./resources";
import { getStore } from "./store";
import { validateRequestBody } from "./validation";

/**
 * Try to handle a request as a stateful CRUD operation or a list-only
 * read against the spec's example collection. Returns true if a
 * response was sent (caller should NOT proxy to Microcks). Returns
 * false to fall through.
 */
export async function tryHandleStateful(
  system: string,
  spec: SystemSpec,
  pathname: string,
  query: URLSearchParams,
  req: Request,
  res: Response,
): Promise<boolean> {
  const resources = detectResources(spec.specPath);
  if (resources.length === 0) return false;
  const match = matchResource(resources, pathname);
  if (!match) return false;

  const method = req.method.toUpperCase();
  const store = getStore(system);
  const { resource, kind } = match;
  const isCrud = Boolean(resource.itemPath && resource.idParam);

  if (kind === "collection" && method === "POST") {
    // POST is only meaningful for CRUD resources. For list-only
    // (Calendly-style) resources we leave POST to fall through.
    if (!isCrud) return false;
    const body = readObject(req);
    const v = validateRequestBody(spec.specPath, resource, "POST", body);
    if (!v.ok) {
      res.status(400).json({ error: "validation_failed", details: v.errors });
      return true;
    }
    const created = createEntity(store, resource, body);
    res.status(201).json(created);
    return true;
  }

  if (kind === "collection" && method === "GET") {
    // Source of truth: user-created records if any, otherwise the
    // spec's example collection (extracted at resource-detection
    // time). If neither exists, fall through so Microcks can answer.
    const stored = store.list(resource.name) as Record<string, unknown>[];
    const seed =
      stored.length > 0
        ? stored
        : ((resource.exampleCollection ?? []) as Record<string, unknown>[]);
    if (seed.length === 0) return false;

    res
      .status(200)
      .json(buildListResponse(resource, seed, query, req, system));
    return true;
  }

  if (kind === "item" && match.id !== undefined && isCrud) {
    const id = match.id;
    const idParam = resource.idParam as string;
    if (method === "GET") {
      const stored = store.get(resource.name, id);
      if (!stored) return false;
      res.status(200).json(stored);
      return true;
    }
    if (method === "PUT") {
      const body = readObject(req);
      const v = validateRequestBody(spec.specPath, resource, "PUT", body);
      if (!v.ok) {
        res.status(400).json({ error: "validation_failed", details: v.errors });
        return true;
      }
      const entity = { ...body, [idParam]: id };
      store.put(resource.name, id, entity);
      res.status(200).json(entity);
      return true;
    }
    if (method === "PATCH") {
      const body = readObject(req);
      const v = validateRequestBody(spec.specPath, resource, "PATCH", body);
      if (!v.ok) {
        res.status(400).json({ error: "validation_failed", details: v.errors });
        return true;
      }
      const existing = store.get(resource.name, id);
      if (!existing) {
        res.status(404).json({ error: "not_found", id });
        return true;
      }
      const merged = { ...existing, ...body, [idParam]: id };
      store.put(resource.name, id, merged);
      res.status(200).json(merged);
      return true;
    }
    if (method === "DELETE") {
      const ok = store.delete(resource.name, id);
      if (ok) res.status(204).end();
      else res.status(404).json({ error: "not_found", id });
      return true;
    }
  }

  return false;
}

/* ─── shared logic used by both HTTP handler and CLI commands ─── */

export function createEntity(
  store: ReturnType<typeof getStore>,
  resource: ResourceDef,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const idParam = resource.idParam;
  if (!idParam) {
    throw new Error(
      `createEntity called on list-only resource "${resource.name}". This resource doesn't expose item endpoints; create isn't supported.`,
    );
  }
  const id = String(body[idParam] ?? generateId());
  const entity = { ...body, [idParam]: id };
  store.put(resource.name, id, entity);
  return entity;
}

export function buildListResponse(
  r: ResourceDef,
  items: Record<string, unknown>[],
  query: URLSearchParams,
  req?: Request,
  system?: string,
): unknown {
  const sliced = applyPagination(r, items, query);
  if (!r.envelope) return sliced.items;

  // Cursor-style: emit the Calendly-shaped envelope with a real
  // pagination object including next_page / next_page_token URLs that
  // echo the caller's original query filters.
  if (r.pagination?.style === "cursor" && req && system) {
    return {
      [r.envelopeKey]: sliced.items,
      pagination: buildCursorPagination(
        r.examplePagination ?? {},
        sliced,
        r.pagination,
        query,
        buildBaseUrl(req, system, r),
      ),
    };
  }

  // Page/offset-style: fill the spec's declared meta fields by name.
  const wrapped: Record<string, unknown> = { [r.envelopeKey]: sliced.items };
  for (const meta of r.envelopeMeta) {
    if (/^(total|count|totalCount|totalItems)$/i.test(meta))
      wrapped[meta] = sliced.total;
    else if (/^(per[_-]?page|pageSize|page_size|limit)$/i.test(meta))
      wrapped[meta] = sliced.size;
    else if (/^(page|pageNumber|page_number)$/i.test(meta))
      wrapped[meta] = sliced.page;
    else if (/^offset$/i.test(meta)) wrapped[meta] = sliced.offset;
  }
  return wrapped;
}

interface Sliced {
  items: Record<string, unknown>[];
  total: number;
  size: number;
  page: number;
  offset: number;
}

function applyPagination(
  r: ResourceDef,
  items: Record<string, unknown>[],
  query: URLSearchParams,
): Sliced {
  if (!r.pagination) {
    return { items, total: items.length, size: items.length, page: 1, offset: 0 };
  }
  const p = r.pagination;
  if (p.style === "page") {
    const page = clamp(int(query.get(p.pageParam)) ?? 1, 1);
    const size = clamp(int(query.get(p.sizeParam)) ?? p.defaultSize, 1);
    const start = (page - 1) * size;
    const slice = items.slice(start, start + size);
    return { items: slice, total: items.length, size, page, offset: start };
  }
  if (p.style === "cursor") {
    const offset = parseToken(query.get(p.tokenParam));
    const size = clamp(int(query.get(p.sizeParam)) ?? p.defaultSize, 1);
    const slice = items.slice(offset, offset + size);
    return {
      items: slice,
      total: items.length,
      size,
      page: Math.floor(offset / size) + 1,
      offset,
    };
  }
  const offset = clamp(int(query.get(p.offsetParam)) ?? 0, 0);
  const limit = clamp(int(query.get(p.limitParam)) ?? p.defaultLimit, 1);
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    total: items.length,
    size: limit,
    page: Math.floor(offset / limit) + 1,
    offset,
  };
}

/* ─── cursor pagination plumbing ─── */

type CursorPagination = Extract<PaginationDef, { style: "cursor" }>;

/**
 * Build the Calendly-shaped pagination object:
 *
 *   {
 *     "count":               <items in this page>,
 *     "next_page":           "<URL>?…&page_token=…" or null,
 *     "next_page_token":     "<base64-of-next-offset>" or null,
 *     "previous_page":       "<URL>?…[&page_token=…]" or null,
 *     "previous_page_token": "<base64-of-prev-offset>" or null,
 *   }
 *
 * Any other fields the spec's example pagination object had (e.g. "limit",
 * vendor-specific metadata) are preserved from `template`.
 */
function buildCursorPagination(
  template: Record<string, unknown>,
  sliced: Sliced,
  pag: CursorPagination,
  query: URLSearchParams,
  baseUrl: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...template };
  out["count"] = sliced.items.length;

  const nextOffset = sliced.offset + sliced.items.length;
  if (nextOffset < sliced.total && sliced.items.length > 0) {
    const nextToken = encodeToken(nextOffset);
    const nextQ = new URLSearchParams(query);
    nextQ.set(pag.tokenParam, nextToken);
    out["next_page"] = `${baseUrl}?${nextQ.toString()}`;
    out["next_page_token"] = nextToken;
  } else {
    out["next_page"] = null;
    out["next_page_token"] = null;
  }

  if (sliced.offset > 0) {
    const prevOffset = Math.max(0, sliced.offset - sliced.size);
    const prevQ = new URLSearchParams(query);
    if (prevOffset === 0) prevQ.delete(pag.tokenParam);
    else prevQ.set(pag.tokenParam, encodeToken(prevOffset));
    const qs = prevQ.toString();
    out["previous_page"] = qs ? `${baseUrl}?${qs}` : baseUrl;
    out["previous_page_token"] = prevOffset === 0 ? null : encodeToken(prevOffset);
  } else {
    out["previous_page"] = null;
    out["previous_page_token"] = null;
  }

  return out;
}

/**
 * Tokens are base64(<offset>) — opaque enough that callers can't easily
 * hand-craft them, while still being deterministic so we don't need
 * server-side cursor storage.
 */
function encodeToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

function parseToken(token: string | null): number {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const n = Number.parseInt(decoded, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Reconstruct the external URL the caller used. Order of preference:
 *
 *   1. `PUBLIC_BASE_URL` env var (set on deployed servers behind a TLS
 *      reverse proxy) — most reliable, doesn't trust request headers.
 *   2. X-Forwarded-Proto / X-Forwarded-Host from a trusted proxy
 *      (Cloudflare tunnel, Caddy, etc.) — required because the local
 *      Express listener is plain HTTP.
 *   3. The raw req.protocol/host — works for direct localhost hits.
 */
function buildBaseUrl(req: Request, system: string, r: ResourceDef): string {
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl}/mock/${system}${r.collectionPath}`;
  }
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof fwdProto === "string" ? fwdProto.split(",")[0] : fwdProto?.[0]) ??
    (req.secure ? "https" : "http");
  const fwdHost = req.headers["x-forwarded-host"];
  const host =
    (typeof fwdHost === "string" ? fwdHost.split(",")[0] : fwdHost?.[0]) ??
    req.headers.host ??
    `localhost:${config.serverPort}`;
  return `${proto}://${host}/mock/${system}${r.collectionPath}`;
}

/* ─── misc ─── */

function int(s: string | null): number | undefined {
  if (s === null) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}
function clamp(n: number, min: number): number {
  return n < min ? min : n;
}

function readObject(req: Request): Record<string, unknown> {
  const body = (req as Request & { body?: unknown }).body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function generateId(): string {
  return crypto.randomBytes(6).toString("hex");
}
