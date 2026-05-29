import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  loadSpecDoc,
  OpenApiDoc,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiSchema,
  ResourceDef,
} from "./resources";

/**
 * AJV-backed request-body validation against the spec's `requestBody`
 * schema. Schemas are compiled lazily and cached per (specPath × resource ×
 * method). If the spec has no schema for the op, validation degrades to a
 * pass (returns ok: true) — that's intentional so Postman-sourced systems
 * don't reject everything.
 */

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
addFormats(ajv);

const compiledCache = new Map<string, ValidateFunction>();

export function validateRequestBody(
  specPath: string,
  resource: ResourceDef,
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
): ValidationResult {
  const key = `${specPath}::${resource.name}::${method}`;
  let validate = compiledCache.get(key);
  if (!validate) {
    const doc = loadSpecDoc(specPath);
    const schema = pickRequestSchema(doc, resource, method);
    if (!schema) return { ok: true };
    try {
      validate = ajv.compile(inlineRefs(doc, schema, new Set()));
    } catch {
      return { ok: true };
    }
    compiledCache.set(key, validate);
  }
  const ok = validate(body) === true;
  if (ok) return { ok: true };
  const errors = (validate.errors ?? []).map((e) => {
    const where = e.instancePath || "(root)";
    return `${where} ${e.message ?? "is invalid"}`;
  });
  return { ok: false, errors };
}

export function pickRequestSchema(
  doc: OpenApiDoc,
  resource: ResourceDef,
  method: "POST" | "PUT" | "PATCH",
): OpenApiSchema | null {
  const targetPath =
    method === "POST" ? resource.collectionPath : resource.itemPath;
  // List-only resources have no itemPath, so PUT/PATCH have no schema to
  // pick. We return null (== no validation) since they can't be invoked
  // through the gateway anyway.
  if (!targetPath) return null;
  const pathItem: OpenApiPathItem | undefined = doc.paths?.[targetPath];
  if (!pathItem) return null;
  const op: OpenApiOperation | undefined =
    method === "POST"
      ? pathItem.post
      : method === "PUT"
        ? pathItem.put
        : pathItem.patch;
  if (!op) return null;
  const schema =
    op.requestBody?.content?.["application/json"]?.schema ??
    op.requestBody?.content?.["application/*+json"]?.schema;
  return schema ?? null;
}

/**
 * Recursively inline $ref pointers so AJV has a self-contained schema to
 * compile. Visited refs are tracked to avoid cycles.
 */
export function inlineRefs(
  doc: OpenApiDoc,
  schema: OpenApiSchema,
  visited: Set<string>,
): OpenApiSchema {
  if (schema.$ref) {
    if (visited.has(schema.$ref)) return {};
    visited.add(schema.$ref);
    const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (!m || !m[1]) return {};
    const target = doc.components?.schemas?.[m[1]];
    if (!target) return {};
    return inlineRefs(doc, target, visited);
  }
  const out: OpenApiSchema = { ...schema };
  if (schema.properties) {
    const props: Record<string, OpenApiSchema> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      props[k] = inlineRefs(doc, v, new Set(visited));
    }
    out.properties = props;
  }
  if (schema.items) out.items = inlineRefs(doc, schema.items, new Set(visited));
  if (Array.isArray(schema.allOf))
    out.allOf = schema.allOf.map((s) => inlineRefs(doc, s, new Set(visited)));
  if (Array.isArray(schema.oneOf))
    out.oneOf = schema.oneOf.map((s) => inlineRefs(doc, s, new Set(visited)));
  if (Array.isArray(schema.anyOf))
    out.anyOf = schema.anyOf.map((s) => inlineRefs(doc, s, new Set(visited)));
  if (
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties !== null
  ) {
    out.additionalProperties = inlineRefs(
      doc,
      schema.additionalProperties as OpenApiSchema,
      new Set(visited),
    );
  }
  return out;
}
