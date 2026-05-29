import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  isPostmanCollection,
  convertPostmanToOpenApi,
} from "./postman";
import { enforceSpecPolicy } from "../utils/policy";
import { config } from "../config";

/**
 * Minimal OpenAPI type surface we use.
 * We DON'T model everything; just enough for resource detection, request
 * schema extraction, security scheme lookup, and pagination param detection.
 */
export interface OpenApiSchema {
  type?: string;
  $ref?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  format?: string;
  enum?: unknown[];
  default?: unknown;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  additionalProperties?: boolean | OpenApiSchema;
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  required?: boolean;
  schema?: OpenApiSchema;
  $ref?: string;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<
    string,
    {
      content?: Record<
        string,
        {
          schema?: OpenApiSchema;
          // Postman converter and OpenAPI specs may store a single example
          // payload here (used as seed data for cursor-paginated reads).
          example?: unknown;
          examples?: Record<string, { value?: unknown }>;
        }
      >;
    }
  >;
  security?: Array<Record<string, string[]>>;
}

export interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
}

export interface OpenApiSecurityScheme {
  type: "http" | "apiKey" | "oauth2" | "openIdConnect";
  scheme?: "basic" | "bearer";
  bearerFormat?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
  flows?: Record<string, { scopes?: Record<string, string>; tokenUrl?: string }>;
  openIdConnectUrl?: string;
}

export interface OpenApiDoc {
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, OpenApiRequestBody>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  security?: Array<Record<string, string[]>>;
}

/**
 * A "resource" detected from a spec. Two flavours:
 *
 *   1. CRUD resource — both `/foo` and `/foo/{id}` exist. `itemPath` and
 *      `idParam` are set. Stateful (POST/PUT/PATCH/DELETE) handled
 *      against data/<system>.json.
 *
 *   2. List-only resource — `/foo` exists with paginated GET (cursor/
 *      page/offset params) and an envelope response shape, but no
 *      `/foo/{id}` companion. `itemPath`/`idParam` are undefined.
 *      Read-only: GET serves a paginated slice of the spec's example
 *      collection. The user's query filters echo back through the
 *      pagination.next_page URL but are NOT applied as actual filters
 *      against the example records.
 */
export interface ResourceDef {
  name: string;
  collectionPath: string;
  itemPath?: string;
  idParam?: string;
  envelope: boolean;
  envelopeKey: string;
  envelopeMeta: string[];
  pagination?: PaginationDef;
  /** Seed data for list-only resources (extracted from the spec's example). */
  exampleCollection?: unknown[];
  /** Pagination object template from the spec example (we'll overwrite its fields). */
  examplePagination?: Record<string, unknown>;
}

export type PaginationDef =
  | { style: "page"; pageParam: string; sizeParam: string; defaultSize: number }
  | { style: "offset"; offsetParam: string; limitParam: string; defaultLimit: number }
  | { style: "cursor"; tokenParam: string; sizeParam: string; defaultSize: number };

export type SpecFormat = "openapi" | "postman";

interface SpecCache {
  mtime: number;
  doc: OpenApiDoc;
  format: SpecFormat;
  resources: ResourceDef[];
}

const cache = new Map<string, SpecCache>();

function load(specPath: string): SpecCache {
  const stat = fs.statSync(specPath);
  const cached = cache.get(specPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached;

  const raw = fs.readFileSync(specPath, "utf8");
  const parsed = (specPath.endsWith(".json")
    ? JSON.parse(raw)
    : yaml.load(raw)) as unknown;

  enforceSpecPolicy(parsed, path.relative(config.specsDir, specPath));

  let doc: OpenApiDoc;
  let format: SpecFormat;
  if (isPostmanCollection(parsed)) {
    doc = convertPostmanToOpenApi(parsed);
    format = "postman";
  } else {
    doc = (parsed ?? {}) as OpenApiDoc;
    format = "openapi";
  }

  const resources = doc.paths ? buildResources(doc) : [];
  const entry: SpecCache = { mtime: stat.mtimeMs, doc, format, resources };
  cache.set(specPath, entry);
  return entry;
}

export function loadSpecDoc(specPath: string): OpenApiDoc {
  return load(specPath).doc;
}

export function getSpecFormat(specPath: string): SpecFormat {
  return load(specPath).format;
}

export function detectResources(specPath: string): ResourceDef[] {
  return load(specPath).resources;
}

function buildResources(doc: OpenApiDoc): ResourceDef[] {
  const paths = doc.paths ?? {};
  const pathNames = Object.keys(paths);
  const itemPattern = /^(.+?)\/\{([^/}]+)\}$/;
  const out: ResourceDef[] = [];
  const seen = new Set<string>();

  // ── Pass 1: CRUD resources (collection + item endpoints both present) ──
  for (const itemPath of pathNames) {
    const m = itemPath.match(itemPattern);
    if (!m) continue;
    const collectionPath = m[1] as string;
    const idParam = m[2] as string;
    if (!pathNames.includes(collectionPath)) continue;

    const last = lastSegment(collectionPath);
    if (!last) continue;
    if (seen.has(last)) continue;
    seen.add(last);

    const collectionItem = paths[collectionPath];
    const env = detectEnvelope(doc, collectionItem?.get);
    const pagination = detectPagination(doc, collectionItem);
    const example = extractExampleData(collectionItem?.get, env);

    out.push({
      name: last,
      collectionPath,
      itemPath,
      idParam,
      envelope: env.wrap,
      envelopeKey: env.key,
      envelopeMeta: env.meta,
      ...(pagination ? { pagination } : {}),
      ...(example.collection ? { exampleCollection: example.collection } : {}),
      ...(example.pagination ? { examplePagination: example.pagination } : {}),
    });
  }

  // ── Pass 2: list-only resources (collection with pagination, no item) ──
  // These are read-only "browse" endpoints where users send query filters
  // and pagination params but never address a specific record by id.
  for (const collectionPath of pathNames) {
    if (itemPattern.test(collectionPath)) continue; // it's an item path, skip
    const last = lastSegment(collectionPath);
    if (!last) continue;
    if (seen.has(last)) continue;

    const collectionItem = paths[collectionPath];
    if (!collectionItem?.get) continue;
    const pagination = detectPagination(doc, collectionItem);
    const env = detectEnvelope(doc, collectionItem.get);
    // To qualify as a list-only resource we need BOTH: a pagination param
    // set and an envelope-shaped response. Otherwise this is just a random
    // GET endpoint and the gateway should keep proxying it to Microcks.
    if (!pagination || !env.wrap) continue;
    const example = extractExampleData(collectionItem.get, env);

    seen.add(last);
    out.push({
      name: last,
      collectionPath,
      envelope: true,
      envelopeKey: env.key,
      envelopeMeta: env.meta,
      pagination,
      ...(example.collection ? { exampleCollection: example.collection } : {}),
      ...(example.pagination ? { examplePagination: example.pagination } : {}),
    });
  }

  return out;
}

function lastSegment(p: string): string | undefined {
  const segments = p.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || last.includes("{")) return undefined;
  return last;
}

interface EnvelopeInfo {
  wrap: boolean;
  key: string;
  meta: string[];
}

interface ExampleData {
  collection?: unknown[];
  pagination?: Record<string, unknown>;
}

/**
 * Given a GET operation's response definition, find the example payload
 * (Postman's preserved body, or OpenAPI's `example` / `examples`), and
 * pull out:
 *   - the array sitting under the envelope key (the "collection")
 *   - any sibling object that looks like a pagination block
 *
 * The pagination object is found by name match (`pagination` first, then
 * any other object-typed sibling). Returns {} if nothing usable was found.
 */
function extractExampleData(
  op: OpenApiOperation | undefined,
  env: EnvelopeInfo,
): ExampleData {
  if (!env.wrap) return {};
  const content = op?.responses?.["200"]?.content?.["application/json"];
  if (!content) return {};
  const ex =
    content.example !== undefined
      ? content.example
      : firstExampleValue(content.examples);
  if (!ex || typeof ex !== "object" || Array.isArray(ex)) return {};

  const obj = ex as Record<string, unknown>;
  const collectionVal = obj[env.key];
  const collection = Array.isArray(collectionVal) ? collectionVal : undefined;

  let pagination: Record<string, unknown> | undefined;
  if (obj["pagination"] && typeof obj["pagination"] === "object") {
    pagination = obj["pagination"] as Record<string, unknown>;
  } else {
    for (const meta of env.meta) {
      const v = obj[meta];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        pagination = v as Record<string, unknown>;
        break;
      }
    }
  }
  return {
    ...(collection ? { collection } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

function firstExampleValue(
  examples: Record<string, { value?: unknown }> | undefined,
): unknown {
  if (!examples) return undefined;
  for (const ex of Object.values(examples)) {
    if (ex && Object.prototype.hasOwnProperty.call(ex, "value")) {
      return ex.value;
    }
  }
  return undefined;
}

function detectEnvelope(
  doc: OpenApiDoc,
  op: OpenApiOperation | undefined,
): { wrap: boolean; key: string; meta: string[] } {
  const noWrap = { wrap: false, key: "", meta: [] as string[] };
  const schema =
    op?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!schema) return noWrap;
  const resolved = resolveSchemaRef(doc, schema);
  if (!resolved) return noWrap;
  if (resolved.type === "array") return noWrap;
  if (resolved.type === "object" && resolved.properties) {
    const props = Object.entries(resolved.properties);
    const arrayProp = props.find(
      ([, p]) => p.type === "array" || p.items !== undefined,
    );
    if (!arrayProp) return noWrap;
    const meta = props
      .map(([n]) => n)
      .filter((n) => n !== arrayProp[0]);
    return { wrap: true, key: arrayProp[0], meta };
  }
  return noWrap;
}

function detectPagination(
  doc: OpenApiDoc,
  pathItem: OpenApiPathItem | undefined,
): PaginationDef | undefined {
  const op = pathItem?.get;
  const params = [
    ...(pathItem?.parameters ?? []),
    ...(op?.parameters ?? []),
  ]
    .map((p) => resolveParameter(doc, p))
    .filter((p): p is OpenApiParameter => p !== null)
    .filter((p) => p.in === "query");

  const has = (n: string) => params.find((p) => p.name === n);
  const intDefault = (p: OpenApiParameter | undefined, fallback: number) =>
    typeof p?.schema?.default === "number" ? p.schema.default : fallback;

  const pageNames = ["page", "pageNumber", "page_number"];
  const sizeNames = ["per_page", "pageSize", "page_size", "limit", "count"];
  const offsetNames = ["offset", "start", "startIndex"];
  const tokenNames = ["page_token", "pageToken", "cursor", "next_token"];

  // Cursor first — Calendly-style APIs combine `page_token` with `count`,
  // and `count` also appears in our offset-style fallback below, so we
  // need to claim cursor first if a token param is present.
  const token = tokenNames.map(has).find(Boolean);
  if (token) {
    const size =
      has("count") ??
      has("limit") ??
      has("page_size") ??
      has("pageSize") ??
      ({ name: "count" } as OpenApiParameter);
    return {
      style: "cursor",
      tokenParam: token.name,
      sizeParam: size.name,
      defaultSize: intDefault(size, 25),
    };
  }
  const page = pageNames.map(has).find(Boolean);
  if (page) {
    const size =
      sizeNames.map(has).find(Boolean) ??
      ({ name: "per_page" } as OpenApiParameter);
    return {
      style: "page",
      pageParam: page.name,
      sizeParam: size.name,
      defaultSize: intDefault(size, 25),
    };
  }
  const offset = offsetNames.map(has).find(Boolean);
  if (offset) {
    const limit =
      has("limit") ?? has("count") ?? ({ name: "limit" } as OpenApiParameter);
    return {
      style: "offset",
      offsetParam: offset.name,
      limitParam: limit.name,
      defaultLimit: intDefault(limit, 25),
    };
  }
  return undefined;
}

export function resolveSchemaRef(
  doc: OpenApiDoc,
  schema: OpenApiSchema,
): OpenApiSchema | null {
  if (!schema.$ref) return schema;
  const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!m || !m[1]) return null;
  return doc.components?.schemas?.[m[1]] ?? null;
}

export function resolveParameter(
  doc: OpenApiDoc,
  param: OpenApiParameter,
): OpenApiParameter | null {
  if (!param.$ref) return param;
  const m = param.$ref.match(/^#\/components\/parameters\/(.+)$/);
  if (!m || !m[1]) return null;
  return doc.components?.parameters?.[m[1]] ?? null;
}

export interface ResourceMatch {
  resource: ResourceDef;
  kind: "collection" | "item";
  id?: string;
}

export function matchResource(
  resources: ResourceDef[],
  pathname: string,
): ResourceMatch | null {
  for (const r of resources) {
    const collectionRe = collectionPathToRegex(r.collectionPath);
    if (collectionRe.test(pathname)) {
      return { resource: r, kind: "collection" };
    }
    // Only try to match an item URL if this resource actually declares one.
    // List-only resources have no itemPath and must not capture /foo/whatever
    // as an "item" of the foo collection.
    if (!r.itemPath) continue;
    const itemRe = new RegExp(
      "^" + pathToRegexBody(r.collectionPath) + "/([^/]+)/?$",
    );
    const m = pathname.match(itemRe);
    if (m && m[1]) {
      return { resource: r, kind: "item", id: decodeURIComponent(m[1]) };
    }
  }
  return null;
}

function collectionPathToRegex(p: string): RegExp {
  return new RegExp("^" + pathToRegexBody(p) + "/?$");
}

function pathToRegexBody(p: string): string {
  return p
    .split("/")
    .map((seg) =>
      /^\{[^/}]+\}$/.test(seg) ? "[^/]+" : escapeRegex(seg),
    )
    .join("/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
