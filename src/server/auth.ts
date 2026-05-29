import { Request, Response } from "express";
import {
  loadSpecDoc,
  OpenApiDoc,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiSecurityScheme,
} from "./resources";
import {
  defaultJwksUrl,
  issuerForSystem,
  jwksUrlForSystem,
  TokenVerificationError,
  verifyAccessToken,
  type VerifyResult,
} from "./jwt";

/**
 * Auth enforcement against the spec's `securitySchemes`.
 *
 * Source of truth, in order of precedence:
 *
 *   1. The matched operation's `security` block (per-operation override).
 *   2. The spec's top-level `security` block (default for all operations).
 *   3. If neither is set, the gateway accepts anything (no security
 *      declared — same as a real OpenAPI doc would mean).
 *
 * For each AND-group inside an OR-requirement, every scheme must be
 * satisfied. For `oauth2` / `openIdConnect` schemes that means a real
 * JWT verified against the mock-oauth2-server's JWKS — not just a
 * 3-part string. For other schemes (basic, bearer, apiKey) we still
 * only check the header shape, because the mock is the issuer for
 * those and there's nothing to "verify" against.
 */

export interface AuthExpectation {
  schemeName: string;
  scheme: OpenApiSecurityScheme;
  scopes: string[];
}

export type SecurityRequirement = AuthExpectation[];

/**
 * Look up the auth requirements that apply to a specific request.
 * If `method`/`pathname` are provided we try to find a matching
 * operation in the spec first; otherwise we use the top-level
 * security only (legacy behaviour, kept for `mock token`).
 */
export function getAuthExpectations(
  specPath: string,
  method?: string,
  pathname?: string,
): SecurityRequirement[] {
  const doc = loadSpecDoc(specPath);
  const schemes = doc.components?.securitySchemes ?? {};
  const requirements =
    findOperationSecurity(doc, method, pathname) ?? doc.security ?? [];

  const out: SecurityRequirement[] = [];
  for (const requirement of requirements) {
    const resolved: AuthExpectation[] = [];
    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = schemes[name];
      if (!scheme) continue;
      resolved.push({ schemeName: name, scheme, scopes: scopes ?? [] });
    }
    if (resolved.length > 0) out.push(resolved);
  }
  return out;
}

function findOperationSecurity(
  doc: OpenApiDoc,
  method: string | undefined,
  pathname: string | undefined,
): Array<Record<string, string[]>> | undefined {
  if (!method || !pathname) return undefined;
  const paths = doc.paths ?? {};
  const verb = method.toLowerCase() as keyof OpenApiPathItem;
  for (const [pattern, item] of Object.entries(paths)) {
    if (!pathMatches(pattern, pathname)) continue;
    const op = (item as OpenApiPathItem)[verb] as OpenApiOperation | undefined;
    if (op && op.security !== undefined) return op.security;
    // Operation found but no security override → fall back to top-level.
    if (op) return undefined;
  }
  return undefined;
}

/** Match an OpenAPI templated path like `/users/{id}` against `/users/42`. */
function pathMatches(template: string, actual: string): boolean {
  const t = template.replace(/\/+$/, "");
  const a = actual.replace(/\/+$/, "");
  const ts = t.split("/");
  const as = a.split("/");
  if (ts.length !== as.length) return false;
  for (let i = 0; i < ts.length; i++) {
    const seg = ts[i] ?? "";
    if (seg.startsWith("{") && seg.endsWith("}")) continue;
    if (seg !== as[i]) return false;
  }
  return true;
}

export interface AuthCheckResult {
  ok: boolean;
  /** Human-readable description of what we expected. */
  expected: string;
  /** Populated when ok=true and one of the matched schemes was oauth2/oidc. */
  tokenInfo?: VerifyResult;
  /** Populated when ok=false — drives the response status/code. */
  failure?: AuthFailure;
}

export type AuthFailure =
  | { kind: "missing_credentials"; expected: string }
  | { kind: "invalid_token"; reason: string }
  | { kind: "expired_token"; reason: string }
  | { kind: "insufficient_scope"; required: string[]; actual: string[] }
  | { kind: "jwks_unreachable"; reason: string };

/**
 * Async because OAuth verification needs a JWKS fetch. Returns a
 * structured result; the caller renders it via `rejectAuth`.
 *
 * `system` is required to verify OAuth tokens against the correct
 * per-system issuer + JWKS. When unset (e.g. legacy callers) we fall
 * back to the default issuer namespace.
 */
export async function checkAuth(
  req: Request,
  requirements: SecurityRequirement[],
  ctx: { system?: string } = {},
): Promise<AuthCheckResult> {
  if (requirements.length === 0) {
    return { ok: true, expected: "(none)" };
  }

  const expectedHints: string[] = [];
  let lastFailure: AuthFailure | undefined;
  let lastTokenInfo: VerifyResult | undefined;

  for (const requirement of requirements) {
    const hintsForReq: string[] = [];
    let groupOk = true;
    let groupTokenInfo: VerifyResult | undefined;
    let groupFailure: AuthFailure | undefined;

    for (const exp of requirement) {
      hintsForReq.push(describeScheme(exp.schemeName, exp.scheme, exp.scopes));
      const sat = await schemeSatisfied(req, exp, ctx.system);
      if (sat.ok) {
        if (sat.tokenInfo) groupTokenInfo = sat.tokenInfo;
      } else {
        groupOk = false;
        groupFailure = sat.failure;
        break;
      }
    }

    if (groupOk) {
      return {
        ok: true,
        expected: hintsForReq.join(" + "),
        tokenInfo: groupTokenInfo,
      };
    }

    expectedHints.push(hintsForReq.join(" + "));
    if (groupFailure) lastFailure = groupFailure;
    if (groupTokenInfo) lastTokenInfo = groupTokenInfo;
  }

  return {
    ok: false,
    expected: expectedHints.join(" OR "),
    failure: lastFailure ?? {
      kind: "missing_credentials",
      expected: expectedHints.join(" OR "),
    },
    tokenInfo: lastTokenInfo,
  };
}

/**
 * Emit an RFC 6750-shaped response. We map the failure kind to the
 * appropriate status code and `WWW-Authenticate` header.
 */
export function rejectAuth(res: Response, result: AuthCheckResult): void {
  const failure = result.failure ?? {
    kind: "missing_credentials" as const,
    expected: result.expected,
  };

  if (failure.kind === "jwks_unreachable") {
    res.status(503).json({
      error: "auth_server_unavailable",
      description: failure.reason,
      hint: "The OAuth server (mock-oauth2) isn't reachable. Bring the stack up.",
    });
    return;
  }

  if (failure.kind === "insufficient_scope") {
    res
      .status(403)
      .setHeader(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${failure.required.join(" ")}"`,
      )
      .json({
        error: "insufficient_scope",
        required_scopes: failure.required,
        actual_scopes: failure.actual,
        hint: `The token is valid but missing scopes: ${failure.required
          .filter((s) => !failure.actual.includes(s))
          .join(", ")}. Re-mint with \`mock token <system>\` after editing the spec's required scopes, or pass extra scopes when minting.`,
      });
    return;
  }

  let errorCode = "invalid_request";
  let description = result.expected;
  if (failure.kind === "invalid_token") {
    errorCode = "invalid_token";
    description = failure.reason;
  } else if (failure.kind === "expired_token") {
    errorCode = "invalid_token";
    description = failure.reason;
  }

  const params = [`error="${errorCode}"`];
  if (description) params.push(`error_description="${description.replace(/"/g, "")}"`);

  res
    .status(401)
    .setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`)
    .json({
      error: errorCode,
      expected: result.expected,
      description,
      hint:
        "Use `mock token <system> --raw` to get a credential matching the spec's auth scheme.",
    });
}

function describeScheme(
  name: string,
  s: OpenApiSecurityScheme,
  scopes: string[] = [],
): string {
  const scopePart = scopes.length > 0 ? ` scopes=[${scopes.join(", ")}]` : "";
  if (s.type === "http" && s.scheme === "basic") return `http/basic (${name})${scopePart}`;
  if (s.type === "http" && s.scheme === "bearer") return `http/bearer (${name})${scopePart}`;
  if (s.type === "oauth2" || s.type === "openIdConnect")
    return `${s.type} JWT (${name})${scopePart}`;
  if (s.type === "apiKey")
    return `apiKey "${s.name ?? "?"}" in ${s.in ?? "?"} (${name})`;
  return `${s.type} (${name})`;
}

interface SchemeCheck {
  ok: boolean;
  failure?: AuthFailure;
  tokenInfo?: VerifyResult;
}

async function schemeSatisfied(
  req: Request,
  exp: AuthExpectation,
  system?: string,
): Promise<SchemeCheck> {
  const s = exp.scheme;

  // http/basic, http/bearer, apiKey — header-shape checks only. The
  // mock is the source of truth for these; there's nothing to "verify".
  if (s.type === "http" && s.scheme === "basic") {
    const ok = /^basic\s+.+/i.test(headerValue(req, "authorization") ?? "");
    return ok
      ? { ok: true }
      : { ok: false, failure: { kind: "missing_credentials", expected: "Authorization: Basic …" } };
  }
  if (s.type === "http" && s.scheme === "bearer") {
    const ok = /^bearer\s+.+/i.test(headerValue(req, "authorization") ?? "");
    return ok
      ? { ok: true }
      : { ok: false, failure: { kind: "missing_credentials", expected: "Authorization: Bearer …" } };
  }
  if (s.type === "apiKey") {
    const where = s.in;
    const name = s.name ?? "";
    if (!name) return { ok: false, failure: { kind: "missing_credentials", expected: "apiKey with no name in spec" } };
    let present = false;
    if (where === "header") present = Boolean(headerValue(req, name));
    else if (where === "query")
      present = Boolean((req.query as Record<string, unknown>)[name]);
    else if (where === "cookie") {
      const cookieHeader = headerValue(req, "cookie");
      const re = cookieHeader
        ? new RegExp("(?:^|;\\s*)" + escapeRegex(name) + "=")
        : null;
      present = Boolean(re && re.test(cookieHeader ?? ""));
    }
    return present
      ? { ok: true }
      : {
          ok: false,
          failure: {
            kind: "missing_credentials",
            expected: `apiKey "${name}" in ${where}`,
          },
        };
  }

  // oauth2 / openIdConnect — real verification against the JWKS.
  if (s.type === "oauth2" || s.type === "openIdConnect") {
    const authz = headerValue(req, "authorization");
    const m = authz ? /^bearer\s+(.+)$/i.exec(authz) : null;
    if (!m || !m[1]) {
      return {
        ok: false,
        failure: {
          kind: "missing_credentials",
          expected: "Authorization: Bearer <JWT>",
        },
      };
    }
    try {
      const result = await verifyAccessToken(
        m[1],
        {
          requiredScopes: exp.scopes,
          // Per-system iss check: a token minted under issuer "calendly"
          // cannot be replayed against issuer "mimecast" because their
          // `iss` claims differ.
          issuer: system ? issuerForSystem(system) : undefined,
        },
        system ? jwksUrlForSystem(system) : undefined,
      );
      return { ok: true, tokenInfo: result };
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        const d = err.detail;
        if (d.kind === "insufficient_scope") {
          return { ok: false, failure: d };
        }
        if (d.kind === "expired_token") {
          return { ok: false, failure: d };
        }
        if (d.kind === "jwks_unreachable") {
          return { ok: false, failure: d };
        }
        return {
          ok: false,
          failure: { kind: "invalid_token", reason: d.reason },
        };
      }
      return {
        ok: false,
        failure: {
          kind: "invalid_token",
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    ok: false,
    failure: {
      kind: "missing_credentials",
      expected: `unsupported scheme type ${s.type}`,
    },
  };
}

function headerValue(req: Request, name: string): string | undefined {
  const lower = name.toLowerCase();
  const h = req.headers[lower];
  if (typeof h === "string") return h;
  if (Array.isArray(h) && h.length > 0) return h[0];
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-export for `mock info` etc. that want to render the doc's schemes.
export function getSchemesForInfo(specPath: string): {
  securitySchemes: Record<string, OpenApiSecurityScheme>;
  hasTopLevelSecurity: boolean;
  /** Number of operations that declare a per-operation security override. */
  operationsWithSecurity: number;
  /** The JWKS URL the gateway will verify oauth tokens against. */
  jwksUrl: string;
} {
  const doc: OpenApiDoc = loadSpecDoc(specPath);
  let opsWith = 0;
  for (const item of Object.values(doc.paths ?? {})) {
    for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
      const op = (item as OpenApiPathItem)[verb];
      if (op?.security !== undefined) opsWith += 1;
    }
  }
  return {
    securitySchemes: doc.components?.securitySchemes ?? {},
    hasTopLevelSecurity: (doc.security ?? []).length > 0,
    operationsWithSecurity: opsWith,
    jwksUrl: defaultJwksUrl(),
  };
}
