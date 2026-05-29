import fs from "fs";
import path from "path";
import kleur from "kleur";
import { config } from "../config";
import { log } from "../utils/logger";

/**
 * Scaffold a workspace for the CLI in the current directory:
 *
 *   ./specs/.gitkeep
 *   ./specs/README.md   (how to drop a spec in)
 *   ./data/.gitkeep
 *
 * Idempotent — re-running won't clobber anything that already exists,
 * it just reports what's in place.
 */
export async function initCommand(): Promise<void> {
  const cwd = process.cwd();
  log.step(`Scaffolding mock-server workspace in ${cwd}…`);

  const specsDir = config.specsDir;
  const dataDir = config.dataDir;
  const specsReadme = path.join(specsDir, "README.md");

  ensureDir(specsDir);
  ensureDir(dataDir);
  ensureFile(path.join(specsDir, ".gitkeep"), "");
  ensureFile(path.join(dataDir, ".gitkeep"), "");
  ensureFile(specsReadme, SPECS_README);

  console.log("");
  log.ok("Workspace ready.");
  console.log("");
  console.log(`${kleur.bold("Next steps:")}`);
  console.log(
    `  1. ${kleur.cyan(`mock up`)} ${kleur.dim("# start Microcks + mock-oauth2 (Docker/Podman required)")}`,
  );
  console.log(
    `  2. Drop a spec file into ${kleur.cyan(`specs/<system>/openapi.yaml`)} (or ${kleur.cyan(`*.postman_collection.json`)}).`,
  );
  console.log(`  3. ${kleur.cyan(`mock add <system>`)}`);
  console.log(`  4. ${kleur.cyan(`mock serve`)} ${kleur.dim("# gateway on http://localhost:3000")}`);
  console.log("");
  log.dim(`Tunnel + state file live globally at ${config.stateDir}.`);
}

function ensureDir(p: string): void {
  if (fs.existsSync(p)) {
    log.dim(`  exists  ${path.relative(process.cwd(), p) || "."}`);
    return;
  }
  fs.mkdirSync(p, { recursive: true });
  log.ok(`  created ${path.relative(process.cwd(), p) || "."}`);
}

function ensureFile(p: string, contents: string): void {
  if (fs.existsSync(p)) {
    log.dim(`  exists  ${path.relative(process.cwd(), p)}`);
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  log.ok(`  created ${path.relative(process.cwd(), p)}`);
}

const SPECS_README = `# specs/

Each subdirectory here is one "system" the CLI can mock.

\`\`\`
specs/
├── calendly/
│   ├── calendly.postman_collection.json
│   └── vendor.json
├── demo-hr/
│   ├── openapi.yaml
│   └── vendor.json
└── ...
\`\`\`

Drop in an OpenAPI YAML/JSON file or a Postman collection. We accept any
single \`.yaml\` / \`.yml\` / \`.json\` file in the folder, with
\`openapi.yaml\` preferred if multiple are present.

\`vendor.json\` is optional but useful — it tells the CLI the display
name and the auth scheme to expect:

\`\`\`json
{
  "displayName": "My System",
  "auth": {
    "type": "bearer",
    "notes": "Use \`mock token <system> --raw\` to mint a JWT."
  }
}
\`\`\`

Then:

    mock add <system>
    mock info <system>
    mock serve

Stored per-system records (POSTs through the gateway, \`mock create\`, etc.)
end up next door in \`../data/<system>.json\`.
`;
