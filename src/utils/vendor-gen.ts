import type { AuthType, VendorMeta } from "./specs";

/**
 * Auto-derive a vendor.json from a parsed spec. Used by `mock import`
 * so the user doesn't have to hand-author one for every new spec.
 *
 * Heuristics:
 *
 *   - displayName: spec.info.title (OpenAPI) or info.name (Postman),
 *     unchanged. Falls back to the system slug if missing.
 *
 *   - auth.type: walks securitySchemes (OpenAPI) and picks the
 *     "strongest" available: oauth2 > openIdConnect > bearer >
 *     apiKey > none. The gateway enforces all declared schemes; this
 *     pick just decides what `mock token <system>` will try to mint
 *     by default.
 *
 *   - auth.scopes: for oauth2 schemes, extracts the scope names from
 *     the first flow that defines them (clientCredentials > password >
 *     authorizationCode > implicit, in that order).
 *
 *   - auth.notes: a small breadcrumb so users (re)reading the file
 *     understand how the values were chosen.
 *
 * The user can edit the resulting vendor.json any time; nothing here
 * is canonical, just opinionated defaults.
 */

export interface DerivedVendor extends VendorMeta {
  /** What we noticed in the spec while deriving (for UI display). */
  rationale: string[];
}

interface ParsedSpecForVendor {
  info?: { title?: string; name?: string };
  components?: { securitySchemes?: Record<string, RawScheme> };
  // Postman collections don't have components.securitySchemes; they
  // typically declare auth at the collection/item level. We accept
  // the raw `auth` shape Postman uses and degrade gracefully.
  auth?: { type?: string };
}

interface RawScheme {
  type?: string;
  scheme?: string;
  flows?: Record<string, { scopes?: Record<string, string> }>;
}

const AUTH_RANK: Record<AuthType, number> = {
  none: 0,
  apiKey: 1,
  bearer: 2,
  oauth2: 3,
};

export function deriveVendor(
  parsed: unknown,
  systemSlug: string,
): DerivedVendor {
  const spec = parsed as ParsedSpecForVendor;
  const rationale: string[] = [];

  const displayName =
    spec.info?.title?.trim() ||
    spec.info?.name?.trim() ||
    titleCase(systemSlug);
  rationale.push(`displayName ← ${displayName === titleCase(systemSlug) ? "system slug" : "spec.info.title"}`);

  // OpenAPI security schemes — pick the strongest available.
  let pickedType: AuthType = "none";
  let pickedScopes: string[] | undefined;
  const schemes = spec.components?.securitySchemes ?? {};
  for (const [, s] of Object.entries(schemes)) {
    const t = normalizeSchemeType(s);
    if (AUTH_RANK[t] > AUTH_RANK[pickedType]) {
      pickedType = t;
      if (t === "oauth2") {
        pickedScopes = extractScopes(s);
      }
    }
  }

  // Postman fallback — collection-level auth.type.
  if (pickedType === "none" && spec.auth?.type) {
    const t = normalizePostmanAuth(spec.auth.type);
    if (t !== "none") pickedType = t;
  }

  if (pickedType === "none") {
    rationale.push("auth.type ← none (no securitySchemes detected)");
  } else {
    rationale.push(`auth.type ← ${pickedType} (strongest in securitySchemes)`);
    if (pickedScopes && pickedScopes.length > 0) {
      rationale.push(`auth.scopes ← ${pickedScopes.length} extracted from oauth2 flow`);
    }
  }

  return {
    displayName,
    auth: {
      type: pickedType,
      ...(pickedScopes && pickedScopes.length > 0 ? { scopes: pickedScopes } : {}),
      notes: noteFor(pickedType),
    },
    rationale,
  };
}

function normalizeSchemeType(s: RawScheme): AuthType {
  const t = (s.type ?? "").toLowerCase();
  if (t === "oauth2" || t === "openidconnect") return "oauth2";
  if (t === "apikey") return "apiKey";
  if (t === "http") {
    const scheme = (s.scheme ?? "").toLowerCase();
    if (scheme === "bearer") return "bearer";
    if (scheme === "basic") return "bearer"; // closest match in our enum
  }
  return "none";
}

function normalizePostmanAuth(raw: string): AuthType {
  const t = raw.toLowerCase();
  if (t === "oauth2") return "oauth2";
  if (t === "bearer") return "bearer";
  if (t === "apikey") return "apiKey";
  return "none";
}

function extractScopes(s: RawScheme): string[] {
  const flows = s.flows ?? {};
  // Prefer machine-to-machine flows since `mock token` mints via
  // client_credentials by default.
  for (const key of [
    "clientCredentials",
    "password",
    "authorizationCode",
    "implicit",
  ]) {
    const flow = flows[key];
    if (flow?.scopes) {
      const names = Object.keys(flow.scopes);
      if (names.length > 0) return names;
    }
  }
  return [];
}

function noteFor(t: AuthType): string {
  switch (t) {
    case "oauth2":
      return "Auto-derived. Use `mock token <system> --raw` to mint a JWT via the bundled mock-oauth2-server.";
    case "bearer":
      return "Auto-derived. Any non-empty Bearer token is accepted (header-shape check only).";
    case "apiKey":
      return "Auto-derived. Any non-empty value in the configured header/query/cookie is accepted.";
    case "none":
      return "Auto-derived. No security scheme detected — the gateway accepts unauthenticated requests.";
  }
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
