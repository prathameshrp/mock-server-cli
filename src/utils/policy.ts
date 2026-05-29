/**
 * Spec-loader policy enforcement.
 *
 * We refuse to ingest or serve any spec that relies on behavior we can't
 * (or don't want to) faithfully mock. Today that means:
 *
 *   1. Postman pre-request, post-request, or test scripts ("in-flight scripts").
 *      These execute JS inside the Postman/Newman runtime — typically to
 *      mint live OAuth tokens, sign requests, mutate state, etc. We can't
 *      run them server-side and we don't want clients depending on side
 *      effects that won't fire against the mock.
 *
 *   2. Cookie-based authentication. Specifically:
 *        - OpenAPI `securitySchemes.<name>` with type apiKey + in: cookie
 *        - Any operation/path parameter with `in: cookie`
 *      Cookie auth implies a stateful session/CSRF flow we'd be mocking
 *      only superficially; better to reject up front than to fake it.
 *
 * Violations throw `SpecPolicyError` with all findings batched, so the user
 * sees everything at once instead of fixing them one by one.
 */
import { isPostmanCollection } from "../server/postman";

export class SpecPolicyError extends Error {
  readonly violations: PolicyViolation[];
  constructor(specLabel: string, violations: PolicyViolation[]) {
    const header = `Spec "${specLabel}" violates the mock-server policy:`;
    const body = violations
      .map((v, i) => `  ${i + 1}. [${v.rule}] ${v.message}`)
      .join("\n");
    const hint =
      "\n\nThese features can't be mocked safely. Either pick a different spec " +
      "(e.g. the same vendor's OpenAPI download instead of their Postman collection), " +
      "or strip the offending bits before adding the system.";
    super(`${header}\n${body}${hint}`);
    this.name = "SpecPolicyError";
    this.violations = violations;
  }
}

export type PolicyRule =
  | "postman-script"
  | "cookie-auth-scheme"
  | "cookie-parameter";

export interface PolicyViolation {
  rule: PolicyRule;
  message: string;
  location?: string;
}

export function enforceSpecPolicy(parsed: unknown, specLabel: string): void {
  const violations: PolicyViolation[] = [];

  if (isPostmanCollection(parsed)) {
    collectPostmanViolations(parsed as PostmanLike, violations);
  } else {
    collectOpenApiViolations(parsed as OpenApiLike, violations);
  }

  if (violations.length > 0) {
    throw new SpecPolicyError(specLabel, violations);
  }
}

/* ─── Postman walker ─── */

interface PostmanScriptEvent {
  listen?: string;
  script?: { exec?: string[] | string };
  disabled?: boolean;
}

interface PostmanLike {
  info?: { name?: string };
  item?: PostmanLikeItem[];
  event?: PostmanScriptEvent[];
}

interface PostmanLikeItem {
  name?: string;
  item?: PostmanLikeItem[];
  event?: PostmanScriptEvent[];
}

function collectPostmanViolations(
  doc: PostmanLike,
  out: PolicyViolation[],
): void {
  inspectPostmanEvents(doc.event, "<collection root>", out);
  walkPostmanItems(doc.item ?? [], "", out);
}

function walkPostmanItems(
  items: PostmanLikeItem[],
  parentPath: string,
  out: PolicyViolation[],
): void {
  for (const item of items) {
    const here = parentPath
      ? `${parentPath} > ${item.name ?? "<unnamed>"}`
      : (item.name ?? "<unnamed>");
    inspectPostmanEvents(item.event, here, out);
    if (Array.isArray(item.item)) {
      walkPostmanItems(item.item, here, out);
    }
  }
}

function inspectPostmanEvents(
  events: PostmanScriptEvent[] | undefined,
  location: string,
  out: PolicyViolation[],
): void {
  if (!Array.isArray(events)) return;
  for (const ev of events) {
    if (ev.disabled) continue;
    const kind = ev.listen;
    if (kind !== "prerequest" && kind !== "test") continue;
    const exec = ev.script?.exec;
    const lines = Array.isArray(exec) ? exec : exec ? [exec] : [];
    if (!lines.some((l) => typeof l === "string" && l.trim().length > 0)) {
      continue;
    }
    out.push({
      rule: "postman-script",
      location,
      message:
        kind === "prerequest"
          ? `Postman pre-request script found at "${location}". ` +
            `These run client-side (e.g. to mint OAuth tokens or sign requests) and won't fire against the mock.`
          : `Postman test/post-response script found at "${location}". ` +
            `These mutate environment state mid-flight and aren't reproducible against a mock.`,
    });
  }
}

/* ─── OpenAPI walker ─── */

interface OpenApiLike {
  components?: {
    securitySchemes?: Record<string, OpenApiSchemeLike>;
    parameters?: Record<string, OpenApiParamLike>;
  };
  paths?: Record<string, OpenApiPathLike>;
}

interface OpenApiSchemeLike {
  type?: string;
  in?: string;
  name?: string;
  scheme?: string;
}

interface OpenApiParamLike {
  name?: string;
  in?: string;
  $ref?: string;
}

interface OpenApiPathLike {
  parameters?: OpenApiParamLike[];
  get?: { parameters?: OpenApiParamLike[] };
  post?: { parameters?: OpenApiParamLike[] };
  put?: { parameters?: OpenApiParamLike[] };
  patch?: { parameters?: OpenApiParamLike[] };
  delete?: { parameters?: OpenApiParamLike[] };
}

function collectOpenApiViolations(
  doc: OpenApiLike | null | undefined,
  out: PolicyViolation[],
): void {
  if (!doc || typeof doc !== "object") return;

  const schemes = doc.components?.securitySchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!scheme || typeof scheme !== "object") continue;
    if (scheme.type === "apiKey" && scheme.in === "cookie") {
      out.push({
        rule: "cookie-auth-scheme",
        location: `components.securitySchemes.${name}`,
        message:
          `Security scheme "${name}" uses cookie-based authentication ` +
          `(type: apiKey, in: cookie, name: ${scheme.name ?? "?"}). ` +
          `Cookie/session auth isn't mockable here.`,
      });
    }
  }

  const componentParams = doc.components?.parameters ?? {};
  for (const [name, param] of Object.entries(componentParams)) {
    if (param?.in === "cookie") {
      out.push({
        rule: "cookie-parameter",
        location: `components.parameters.${name}`,
        message:
          `Reusable parameter "${name}" is declared with in: cookie. ` +
          `Cookie parameters typically carry session/CSRF tokens, which the mock can't honour.`,
      });
    }
  }

  const paths = doc.paths ?? {};
  for (const [pathName, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    inspectParams(pathItem.parameters, pathName, out);
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = pathItem[method];
      if (op?.parameters) inspectParams(op.parameters, `${method.toUpperCase()} ${pathName}`, out);
    }
  }
}

function inspectParams(
  params: OpenApiParamLike[] | undefined,
  location: string,
  out: PolicyViolation[],
): void {
  if (!Array.isArray(params)) return;
  for (const p of params) {
    if (p?.in === "cookie") {
      out.push({
        rule: "cookie-parameter",
        location,
        message:
          `Parameter "${p.name ?? "?"}" on ${location} is declared with in: cookie. ` +
          `Cookie parameters typically carry session/CSRF tokens, which the mock can't honour.`,
      });
    }
  }
}
