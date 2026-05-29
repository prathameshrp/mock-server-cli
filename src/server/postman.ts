/**
 * Postman v2.1 collection support.
 *
 * Microcks ingests Postman collections natively, so the mock-serving side
 * just works by uploading the file. What this module adds is:
 *   1. Format sniffing so we recognize a Postman collection file.
 *   2. Title/version extraction (Postman uses `info.name`, version is
 *      optional and may be a string or { major, minor, patch }).
 *   3. Conversion into an OpenAPI-shaped doc so downstream code in
 *      resources.ts / auth.ts / stateful.ts works unchanged.
 *
 * Limitations:
 *   - No request-body schemas in Postman, so AJV validation degrades to a
 *     no-op for Postman-sourced systems.
 *   - No formal pagination parameters; pagination detection won't fire
 *     unless the collection happens to declare `page`/`per_page` query
 *     parameters explicitly.
 */
import type {
  OpenApiDoc,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiSchema,
  OpenApiSecurityScheme,
} from "./resources";

/* ─── Postman types (only the bits we read) ─── */

interface PostmanCollection {
  info: PostmanInfo;
  item: PostmanItem[];
  auth?: PostmanAuth;
  variable?: PostmanVar[];
}

interface PostmanInfo {
  name: string;
  description?: string | { content?: string };
  version?:
    | string
    | { major?: number; minor?: number; patch?: number; identifier?: string };
  schema?: string;
  _postman_id?: string;
}

interface PostmanItem {
  name?: string;
  request?: PostmanRequest;
  response?: PostmanResponse[];
  item?: PostmanItem[];
  auth?: PostmanAuth;
}

interface PostmanRequest {
  method?: string;
  url?:
    | string
    | {
        raw?: string;
        path?: Array<string | { value?: string }>;
        host?: string[];
        query?: Array<{ key: string; value: string }>;
        variable?: Array<{ key: string; value?: string }>;
      };
  auth?: PostmanAuth;
  body?: { mode?: string; raw?: string };
  header?: Array<{ key: string; value: string }>;
}

interface PostmanResponse {
  name?: string;
  code?: number;
  status?: string;
  body?: string;
  _postman_previewlanguage?: string;
  header?: Array<{ key: string; value: string }>;
}

interface PostmanAuth {
  type: string;
  basic?: Array<{ key: string; value: string }>;
  bearer?: Array<{ key: string; value: string }>;
  apikey?: Array<{ key: string; value: string }>;
  oauth2?: Array<{ key: string; value: string }>;
}

interface PostmanVar {
  key: string;
  value?: string;
}

/* ─── public API ─── */

export interface PostmanSummary {
  title: string;
  version: string;
}

export function isPostmanCollection(doc: unknown): doc is PostmanCollection {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as { info?: PostmanInfo; item?: unknown };
  if (!Array.isArray(d.item) || !d.info) return false;
  if (typeof d.info.schema === "string" && /getpostman\.com|postman\.com\/json/.test(d.info.schema)) {
    return true;
  }
  if (typeof d.info._postman_id === "string") return true;
  return false;
}

export function readPostmanSummary(doc: unknown): PostmanSummary {
  if (!isPostmanCollection(doc)) {
    throw new Error("Not a Postman collection.");
  }
  const info = doc.info;
  const title = info.name?.trim();
  if (!title) throw new Error("Postman collection has no info.name.");
  const version = extractVersion(info.version) || "1.0.0";
  return { title, version };
}

export function convertPostmanToOpenApi(doc: unknown): OpenApiDoc {
  if (!isPostmanCollection(doc)) {
    throw new Error("Not a Postman collection.");
  }
  const paths: Record<string, OpenApiPathItem> = {};

  walkItems(doc.item, doc.auth, (item, requestPath, method, responses) => {
    const pi = paths[requestPath] ?? (paths[requestPath] = {});
    const op: OpenApiOperation = {
      operationId: item.name,
      ...(extractQueryParameters(item.request).length > 0
        ? { parameters: extractQueryParameters(item.request) }
        : {}),
      responses: buildResponses(responses),
    };
    setOpForMethod(pi, method, op);
  });

  const schemeMap: Record<string, OpenApiSecurityScheme> = {};
  const security: Array<Record<string, string[]>> = [];
  const topAuth = convertAuth(doc.auth);
  if (topAuth) {
    schemeMap[topAuth.name] = topAuth.scheme;
    security.push({ [topAuth.name]: [] });
  }

  const out: OpenApiDoc = {
    paths,
    components:
      Object.keys(schemeMap).length > 0 ? { securitySchemes: schemeMap } : {},
  };
  if (security.length > 0) out.security = security;
  return out;
}

/* ─── walker ─── */

function walkItems(
  items: PostmanItem[],
  inheritedAuth: PostmanAuth | undefined,
  emit: (
    item: PostmanItem,
    path: string,
    method: string,
    responses: PostmanResponse[],
  ) => void,
): void {
  for (const item of items) {
    const auth = item.auth ?? inheritedAuth;
    if (item.item) {
      walkItems(item.item, auth, emit);
      continue;
    }
    if (!item.request) continue;
    const path = extractPath(item.request.url);
    const method = (item.request.method ?? "GET").toUpperCase();
    if (!path) continue;
    emit(item, path, method, item.response ?? []);
  }
}

/**
 * Convert Postman's `request.url.query` entries into OpenAPI parameter
 * definitions so the rest of the codebase (pagination detection, info
 * command output, etc.) sees them.
 *
 * - Skips disabled entries.
 * - Skips entries whose key resolves to an empty string.
 * - Tries to guess a schema type from the value: numeric strings become
 *   `{ type: "integer", default: <N> }`, everything else becomes
 *   `{ type: "string" }`. The `default` is what
 *   `resources.ts → detectPagination` uses for size fallback.
 */
function extractQueryParameters(
  req: PostmanRequest | undefined,
): { name: string; in: "query"; schema?: { type?: string; default?: unknown }; required?: boolean; description?: string }[] {
  const out: ReturnType<typeof extractQueryParameters> = [];
  if (!req) return out;
  const url = req.url;
  if (!url || typeof url !== "object") return out;
  const queries = (url as { query?: Array<{ key: string; value?: string; disabled?: boolean; description?: string | { content?: string } }> }).query;
  if (!Array.isArray(queries)) return out;
  const seen = new Set<string>();
  for (const q of queries) {
    if (q.disabled) continue;
    const name = (q.key ?? "").trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const value = (q.value ?? "").trim();
    const schema: { type?: string; default?: unknown } = {};
    if (/^-?\d+$/.test(value)) {
      schema.type = "integer";
      schema.default = Number.parseInt(value, 10);
    } else {
      schema.type = "string";
      if (value) schema.default = value;
    }
    const description =
      typeof q.description === "string"
        ? q.description
        : q.description?.content;
    out.push({
      name,
      in: "query",
      schema,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

function extractPath(url: PostmanRequest["url"]): string | null {
  if (!url) return null;

  let segments: string[] | undefined;

  if (typeof url === "object" && Array.isArray(url.path)) {
    segments = url.path
      .map((p) => (typeof p === "string" ? p : (p?.value ?? "")))
      .filter((s): s is string => Boolean(s));
  } else {
    const raw =
      typeof url === "string"
        ? url
        : (url as { raw?: string }).raw ?? "";
    if (raw) segments = parseRawUrlPath(raw);
  }

  if (!segments || segments.length === 0) return null;
  segments = segments.filter((s) => !/^\{\{[^}]+\}\}$/.test(s));
  if (segments.length === 0) return null;

  return (
    "/" +
    segments
      .map((s) =>
        s.startsWith(":") ? `{${s.slice(1)}}` : s.replace(/\{\{([^}]+)\}\}/g, ""),
      )
      .filter(Boolean)
      .join("/")
  );
}

function parseRawUrlPath(raw: string): string[] {
  let cleaned = raw.replace(/^\{\{[^}]+\}\}/, "https://x.example.com");
  cleaned = cleaned.replace(/\{\{[^}]+\}\}/g, "x");
  try {
    const u = new URL(
      cleaned.startsWith("/") ? "http://x.example.com" + cleaned : cleaned,
    );
    return u.pathname.split("/").filter(Boolean);
  } catch {
    return cleaned.split("/").filter((s) => s && !/^https?:$/.test(s));
  }
}

function setOpForMethod(
  pi: OpenApiPathItem,
  method: string,
  op: OpenApiOperation,
): void {
  const m = method.toLowerCase();
  if (m === "get") pi.get = op;
  else if (m === "post") pi.post = op;
  else if (m === "put") pi.put = op;
  else if (m === "patch") pi.patch = op;
  else if (m === "delete") pi.delete = op;
}

/* ─── response schema inference ─── */

function buildResponses(
  responses: PostmanResponse[],
): OpenApiOperation["responses"] {
  if (responses.length === 0) return undefined;
  const out: NonNullable<OpenApiOperation["responses"]> = {};
  for (const r of responses) {
    const code = String(r.code ?? 200);
    const isJson =
      r._postman_previewlanguage === "json" ||
      (r.header ?? []).some(
        (h) =>
          h.key.toLowerCase() === "content-type" &&
          /application\/json/.test(h.value),
      );
    if (!isJson || !r.body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.body);
    } catch {
      continue;
    }
    const existing = out[code] ?? (out[code] = { content: {} });
    // Keep both: the inferred schema (used by resources.ts → detectEnvelope)
    // and the raw example value (used by stateful.ts as a seed dataset for
    // cursor-paginated reads).
    existing.content!["application/json"] = {
      schema: inferSchema(parsed),
      example: parsed,
    };
    break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function inferSchema(value: unknown): OpenApiSchema {
  if (value === null) return { type: "object" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? inferSchema(value[0]) : {},
    };
  }
  if (typeof value === "object") {
    const props: Record<string, OpenApiSchema> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      props[k] = inferSchema(v);
    }
    return { type: "object", properties: props };
  }
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return {};
}

/* ─── auth conversion ─── */

interface ConvertedScheme {
  name: string;
  scheme: OpenApiSecurityScheme;
}

function convertAuth(auth: PostmanAuth | undefined): ConvertedScheme | null {
  if (!auth || auth.type === "noauth") return null;
  switch (auth.type) {
    case "basic":
      return { name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
    case "bearer":
      return {
        name: "bearerAuth",
        scheme: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      };
    case "apikey": {
      const lookup = (k: string) =>
        auth.apikey?.find((x) => x.key === k)?.value;
      const inField = (lookup("in") ?? "header") as
        | "header"
        | "query"
        | "cookie";
      const keyName = lookup("key") ?? "X-API-Key";
      return {
        name: "apiKeyAuth",
        scheme: { type: "apiKey", in: inField, name: keyName },
      };
    }
    case "oauth2":
      return {
        name: "oauth2Auth",
        scheme: {
          type: "oauth2",
          flows: { clientCredentials: { tokenUrl: "", scopes: {} } },
        },
      };
    default:
      return null;
  }
}

function extractVersion(v: PostmanInfo["version"]): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.trim() || null;
  const parts: string[] = [];
  if (typeof v.major === "number") parts.push(String(v.major));
  if (typeof v.minor === "number") parts.push(String(v.minor));
  if (typeof v.patch === "number") parts.push(String(v.patch));
  const base = parts.join(".") || null;
  if (base && v.identifier) return `${base}-${v.identifier}`;
  return base;
}
