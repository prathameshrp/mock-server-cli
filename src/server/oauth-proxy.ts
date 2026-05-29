import type { Request, Response, NextFunction } from "express";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";
import { config } from "../config";

/**
 * Per-system OAuth2/OIDC proxy.
 *
 * Exposes the mock-oauth2-server (navikt) under the gateway's URL
 * space so external clients only need one base URL:
 *
 *   POST /mock/<system>/oauth/token
 *   GET  /mock/<system>/oauth/jwks
 *   GET  /mock/<system>/oauth/.well-known/openid-configuration
 *   GET  /mock/<system>/oauth/authorize
 *   ...etc, anything mock-oauth2 serves under /<issuer>/*
 *
 * Why two URL spaces, then?
 *
 *   mock-oauth2 derives the issuer URL from the request — its
 *   discovery doc embeds URLs like `<scheme>://<host>/<issuer>/token`
 *   based on what hit it. We want clients to see
 *   `<gateway>/mock/<system>/oauth/token` everywhere instead, so we
 *   intercept JSON responses and rewrite the prefix on the way out.
 *
 * Per-system isolation:
 *
 *   We map gateway path `/mock/<system>/oauth/*` to mock-oauth2's
 *   `/<system>/*`, so each system gets its own issuer namespace.
 *   navikt mock-oauth2-server auto-creates issuers on first hit, so
 *   no config is needed. A token minted under issuer `calendly`
 *   cannot be reused for issuer `mimecast` because their `iss` claims
 *   differ and the gateway verifies `iss` per-system.
 *
 * Caveat: the JWT itself is signed and carries `iss =
 * <internal-oauth-url>/<system>`. We don't (can't) rewrite that
 * without re-signing. The gateway verifies that internal-form iss
 * because both ends know it. External clients treat access tokens as
 * opaque (per RFC 6749), so this is fine.
 */

const OAUTH_SUFFIX_RE = /^\/mock\/([^\/]+)\/oauth(\/.*)?$/;

export function createOAuthProxy() {
  return createProxyMiddleware({
    target: config.oauthUrl,
    changeOrigin: true,
    // Selfhandle so we can transform JSON bodies before they go out.
    selfHandleResponse: true,
    pathRewrite: (path: string): string => {
      const m = OAUTH_SUFFIX_RE.exec(path);
      if (!m) return path;
      const system = m[1] ?? "";
      const rest = m[2] ?? "/";
      return `/${system}${rest}`;
    },
    on: {
      proxyRes: responseInterceptor(
        async (responseBuffer, proxyRes, req, _res) => {
          const contentType = (proxyRes.headers["content-type"] ?? "").toString();
          // Only rewrite JSON. Anything else (HTML login pages, etc.)
          // passes through unchanged.
          if (!contentType.includes("application/json")) {
            return responseBuffer;
          }
          const r = req as Request;
          const match = OAUTH_SUFFIX_RE.exec(r.originalUrl ?? r.url ?? "");
          if (!match) return responseBuffer;
          const system = match[1] ?? "";
          return rewriteOAuthUrls(responseBuffer.toString("utf8"), system, r);
        },
      ),
    },
  });
}

/**
 * Rewrite any embedded references to the mock-oauth2 internal URL
 * (`<oauthUrl>/<system>`) so clients see the gateway URL prefix
 * (`<publicBaseUrl>/mock/<system>/oauth`) in discovery docs and the
 * surrounding token-response envelope.
 *
 * The JWT inside `access_token` / `id_token` is base64'd & signed,
 * so this regex won't touch it — `iss` claim stays as the internal
 * URL, which the gateway is configured to verify against. Clients
 * treat the access token as opaque, so they never see the mismatch.
 */
function rewriteOAuthUrls(body: string, system: string, req: Request): string {
  const internalBase = `${config.oauthUrl.replace(/\/+$/, "")}/${system}`;
  const externalBase = `${publicBaseUrlFor(req)}/mock/${system}/oauth`;
  // Plain string replace is fine — the internal URL is specific
  // enough to never appear elsewhere.
  return body.split(internalBase).join(externalBase);
}

function publicBaseUrlFor(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto =
    (typeof fwdProto === "string" ? fwdProto.split(",")[0] : fwdProto?.[0]) ??
    (req.secure ? "https" : "http");
  const fwdHost = req.headers["x-forwarded-host"];
  const host =
    (typeof fwdHost === "string" ? fwdHost.split(",")[0] : fwdHost?.[0]) ??
    req.headers.host ??
    `localhost:${config.serverPort}`;
  return `${proto}://${host}`;
}

/**
 * Express middleware adapter — only invokes the proxy when the URL
 * matches `/mock/<system>/oauth/*`. Keeps app.ts uncluttered.
 */
export function oauthGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!OAUTH_SUFFIX_RE.test(req.url)) return next();
  const proxy = createOAuthProxy();
  proxy(req, res, next);
}
