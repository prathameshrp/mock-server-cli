#!/usr/bin/env node
/**
 * Postbuild step: turn dist/cli.js into a runnable binary.
 *
 *   1. Swap the shebang from `#!/usr/bin/env tsx` (dev) to
 *      `#!/usr/bin/env node` (packaged).
 *   2. chmod +x so `mock` works directly after `npm link`.
 *
 * Kept in /scripts (not /src) so the build doesn't recursively pick
 * itself up.
 */
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");
if (!fs.existsSync(cliPath)) {
  console.error(`postbuild: ${cliPath} does not exist — did tsc fail?`);
  process.exit(1);
}

let src = fs.readFileSync(cliPath, "utf8");
const NODE_SHEBANG = "#!/usr/bin/env node";

if (src.startsWith("#!")) {
  const firstNewline = src.indexOf("\n");
  const rest = firstNewline >= 0 ? src.slice(firstNewline) : "";
  src = NODE_SHEBANG + rest;
} else {
  src = NODE_SHEBANG + "\n" + src;
}

fs.writeFileSync(cliPath, src);
fs.chmodSync(cliPath, 0o755);
console.log(`postbuild: ${path.relative(process.cwd(), cliPath)} → +x, shebang fixed`);
