import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
} from "jose";
import { config } from "../config";

/**
 * JWT signature verification against the mock-oauth2-server's JWKS.
 *
 * The OAuth server (navikt/mock-oauth2-server) signs tokens with an
 * RSA key it generates on startup and publishes at
 * `${oauthUrl}/default/jwks`. We verify against that.
 *
 *   - JWKS is cached in-process by `createRemoteJWKSet` (jose handles
 *     TTL + refresh on unknown kid). A mock-oauth2 restart rotates the
 *     key; the JWKS cache will refresh on the first 4xx/5xx because
 *     the new tokens have an unknown kid.
 *
 *   - We verify signature + `exp` claim. Issuer and audience checks
 *     are optional and gated on flags so existing tokens minted via
 *     `mock token <system>` keep working even though they don't set
 *     a specific audience.
 *
 *   - Scope verification is done by the caller (in auth.ts) because
 *     it depends on the matched operation's `security` requirement,
 *     not on the token itself.
 *
 * For the single-issuer default this module is enough. When we add
 * per-system issuers (Phase 2) we'll keep one JWKS per issuer URL,
 * keyed by issuer string.
 */

export interface VerifyOptions {
  /** RFC 6750: required scopes the operation declared, if any. */
  requiredScopes?: string[];
  /** Restrict to a specific audience claim, if the spec demands one. */
  audience?: string;
  /** Restrict to a specific iss claim, if the spec demands one. */
  issuer?: string;
}

export interface VerifyResult {
  payload: JWTPayload;
  /** Scopes parsed from the token's `scope` (space-separated) or `scp` (array) claim. */
  scopes: string[];
}

/** Stable categories the caller (auth.ts) maps to 401/403 + RFC 6750 error codes. */
export type VerifyError =
  | { kind: "invalid_token"; reason: string }
  | { kind: "expired_token"; reason: string }
  | { kind: "insufficient_scope"; required: string[]; actual: string[] }
  | { kind: "jwks_unreachable"; reason: string };

export class TokenVerificationError extends Error {
  readonly detail: VerifyError;
  constructor(detail: VerifyError) {
    super(detail.kind);
    this.detail = detail;
  }
}

// One JWKS getter per JWKS URL. Lazily created so test runs that never
// touch OAuth don't fire any HTTP requests.
const jwksGetters = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let g = jwksGetters.get(url);
  if (!g) {
    g = createRemoteJWKSet(new URL(url), {
      // 10-minute key cache; if a token references an unknown kid, jose
      // will refresh the JWKS automatically (handles mock-oauth2 restart).
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    jwksGetters.set(url, g);
  }
  return g;
}

/** Where to fetch the JWKS for the default mock-oauth2 issuer. */
export function defaultJwksUrl(): string {
  return `${config.oauthUrl.replace(/\/+$/, "")}/default/jwks`;
}

/**
 * Per-system JWKS URL. mock-oauth2-server auto-creates the issuer
 * on first hit, so just naming `<system>` here is enough to get a
 * fresh signing namespace per system. A Calendly token cannot be
 * replayed against the Mimecast mock and vice versa (different
 * signing keys per issuer).
 */
export function jwksUrlForSystem(system: string): string {
  return `${config.oauthUrl.replace(/\/+$/, "")}/${encodeURIComponent(system)}/jwks`;
}

/**
 * The internal-URL form of the issuer claim that mock-oauth2-server
 * stamps into tokens it mints under `/<system>/token`. Verifying
 * against this guarantees the token was minted in this system's
 * namespace — preventing cross-system token replay.
 */
export function issuerForSystem(system: string): string {
  return `${config.oauthUrl.replace(/\/+$/, "")}/${encodeURIComponent(system)}`;
}

/** Per-system token endpoint on the OAuth server. */
export function tokenUrlForSystem(system: string): string {
  return `${config.oauthUrl.replace(/\/+$/, "")}/${encodeURIComponent(system)}/token`;
}

/**
 * Verify a JWT access token and (optionally) check it carries the
 * required scopes. Throws `TokenVerificationError` with a stable
 * `detail.kind` the caller maps to HTTP status + RFC 6750 error.
 */
export async function verifyAccessToken(
  token: string,
  opts: VerifyOptions = {},
  jwksUrl: string = defaultJwksUrl(),
): Promise<VerifyResult> {
  const verifyOpts: JWTVerifyOptions = {};
  if (opts.audience) verifyOpts.audience = opts.audience;
  if (opts.issuer) verifyOpts.issuer = opts.issuer;

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwksFor(jwksUrl), verifyOpts);
    payload = result.payload;
  } catch (err) {
    throw classifyVerifyError(err, jwksUrl);
  }

  const scopes = extractScopes(payload);
  if (opts.requiredScopes && opts.requiredScopes.length > 0) {
    const missing = opts.requiredScopes.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      throw new TokenVerificationError({
        kind: "insufficient_scope",
        required: opts.requiredScopes,
        actual: scopes,
      });
    }
  }

  return { payload, scopes };
}

function classifyVerifyError(
  err: unknown,
  jwksUrl: string,
): TokenVerificationError {
  // joseErrors.JWTExpired: exp claim in the past.
  if (err instanceof joseErrors.JWTExpired) {
    return new TokenVerificationError({
      kind: "expired_token",
      reason: "JWT exp claim is in the past",
    });
  }
  // joseErrors.JWTClaimValidationFailed: aud/iss/etc mismatch.
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return new TokenVerificationError({
      kind: "invalid_token",
      reason: `claim validation failed: ${err.claim} ${err.reason}`,
    });
  }
  // joseErrors.JWSSignatureVerificationFailed: signature bad.
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new TokenVerificationError({
      kind: "invalid_token",
      reason: "signature verification failed",
    });
  }
  // joseErrors.JWKSNoMatchingKey or JWKSMultipleMatchingKeys: kid mismatch.
  if (err instanceof joseErrors.JOSEError && err.code?.startsWith("ERR_JWKS_")) {
    return new TokenVerificationError({
      kind: "invalid_token",
      reason: `JWKS key resolution failed (${err.code})`,
    });
  }
  // Network failure fetching JWKS. Surfaces as a generic error from fetch.
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT")
  ) {
    return new TokenVerificationError({
      kind: "jwks_unreachable",
      reason: `couldn't reach JWKS at ${jwksUrl}: ${msg}`,
    });
  }
  // Default — treat unknown errors as invalid token rather than 500.
  return new TokenVerificationError({
    kind: "invalid_token",
    reason: msg,
  });
}

function extractScopes(payload: JWTPayload): string[] {
  // RFC 8693 / OIDC: scopes can be in `scope` (string, space-separated) or
  // `scp` (array of strings). Some IdPs use `scopes` too. Accept all.
  const raw =
    (payload as Record<string, unknown>)["scope"] ??
    (payload as Record<string, unknown>)["scp"] ??
    (payload as Record<string, unknown>)["scopes"];
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}
