import { config, cliPrefix } from "../config";
import { log } from "../utils/logger";
import { createApp } from "../server/app";

export async function serveCommand(): Promise<void> {
  const app = createApp();
  const port = config.serverPort;

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port);

    server.on("listening", () => {
      log.ok(`Mock gateway listening on http://localhost:${port}`);
      log.dim(`  • GET /              — list configured systems`);
      log.dim(`  • GET /healthz       — health check`);
      log.dim(`  • *   /mock/<sys>/…  — auth → stateful CRUD → Microcks`);
      log.dim(`  Press Ctrl+C to stop.`);
      resolve();
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Another \`mock serve\` is probably running.\n` +
              `  • If that's the one you want, no action needed — call http://localhost:${port}/mock/<system>/... directly.\n` +
              `  • To restart fresh: \`lsof -ti :${port} | xargs kill\`, then re-run \`${cliPrefix} serve\`.`,
          ),
        );
        return;
      }
      reject(err);
    });
  });

  // Keep process alive forever.
  await new Promise(() => undefined);
}
