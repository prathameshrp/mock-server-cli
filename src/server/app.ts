import express, { Request, Response, NextFunction } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { config, cliPrefix } from "../config";
import { listSystems, resolveSystemSpec, SystemSpec } from "../utils/specs";
import { tryHandleStateful } from "./stateful";
import { checkAuth, getAuthExpectations, rejectAuth } from "./auth";
import { oauthGate } from "./oauth-proxy";

/**
 * Headless HTTP gateway. No dashboard, no spec-upload UI.
 *
 * Routing model:
 *   GET  /healthz                           — liveness
 *   GET  /                                  — JSON listing of available systems
 *   *    /mock/<system>/<rest...>           — auth check → stateful CRUD → Microcks proxy
 *
 * The /mock/<system> prefix is rewritten to /rest/<Service Name>/<Version>
 * before being proxied to Microcks, so callers don't need to know the
 * Microcks naming convention.
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Behind a reverse proxy (Caddy/Nginx/Cloudflare) we need to honour the
  // X-Forwarded-* headers so req.protocol/req.host reflect the public URL,
  // not the upstream-internal one. Enabled when TRUST_PROXY is set; defaults
  // on in container mode (see config.ts).
  if (config.trustProxy) app.set("trust proxy", true);

  app.use(express.json({ limit: "5mb" }));

  // Liveness + readiness in one — the route doesn't touch Microcks, so
  // Caddy / your load balancer can hit it cheaply.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      publicBaseUrl: config.publicBaseUrl ?? null,
      microcksUrl: config.microcksUrl,
    });
  });

  app.get("/", (_req, res) => {
    const systems = listSystems().map((s) => {
      try {
        const spec = resolveSystemSpec(s);
        return {
          system: s,
          format: spec.format,
          title: spec.openapi.title,
          version: spec.openapi.version,
          baseUrl: `/mock/${s}`,
        };
      } catch (e) {
        return { system: s, error: (e as Error).message };
      }
    });
    res.json({
      microcksUrl: config.microcksUrl,
      systems,
      hint: "Send requests to /mock/<system>/<your-path>",
    });
  });

  // OAuth proxy is registered FIRST so it captures `/mock/<system>/oauth/*`
  // before the API dispatcher tries to parse those paths as resource
  // collections. Anything under /oauth/ goes to mock-oauth2-server.
  app.use(oauthGate);

  app.use("/mock/:system", systemDispatcher);

  app.use(((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "internal_error", message: msg });
  }) as express.ErrorRequestHandler);

  return app;
}

async function systemDispatcher(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const system = req.params["system"];
  if (!system) {
    res.status(400).json({ error: "missing system in path" });
    return;
  }

  let spec: SystemSpec;
  try {
    spec = resolveSystemSpec(system);
  } catch (e) {
    res.status(404).json({
      error: "unknown_system",
      system,
      hint: `Did you run \`${cliPrefix} add ${system}\`? See \`${cliPrefix} list\`.`,
      details: (e as Error).message,
    });
    return;
  }

  const rest = req.url.length > 1 ? req.url : "/";
  const [pathPart, queryPart = ""] = rest.split("?");
  const pathname = pathPart || "/";
  const query = new URLSearchParams(queryPart);

  try {
    const expectations = getAuthExpectations(
      spec.specPath,
      req.method,
      pathname,
    );
    const authResult = await checkAuth(req, expectations, { system });
    if (!authResult.ok) {
      rejectAuth(res, authResult);
      return;
    }
  } catch (e) {
    res.status(500).json({
      error: "auth_setup_failed",
      message: (e as Error).message,
    });
    return;
  }

  try {
    const handled = await tryHandleStateful(
      system,
      spec,
      pathname,
      query,
      req,
      res,
    );
    if (handled) return;
  } catch (e) {
    res
      .status(500)
      .json({ error: "stateful_handler_failed", message: (e as Error).message });
    return;
  }

  // Fall through to Microcks.
  const microcksPrefix = `/rest/${encodeURIComponent(spec.openapi.title)}/${encodeURIComponent(
    spec.openapi.version,
  )}`;
  const targetPath = microcksPrefix + pathname + (queryPart ? `?${queryPart}` : "");

  const proxy = createProxyMiddleware({
    target: config.microcksUrl,
    changeOrigin: true,
    pathRewrite: () => targetPath,
    on: {
      proxyReq: (proxyReq, req2) => {
        fixRequestBody(proxyReq, req2 as Request);
      },
      error: (err, _req2, res2) => {
        const r = res2 as Response;
        if (!r.headersSent) {
          r.status(502).json({
            error: "microcks_unreachable",
            message: err.message,
            hint:
              `Run \`${cliPrefix} up\` to start Microcks, or check that http://localhost:8585 is reachable.`,
          });
        }
      },
    },
  });

  proxy(req, res, next);
}
