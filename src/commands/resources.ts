import kleur from "kleur";
import { log } from "../utils/logger";
import { resolveSystemSpec } from "../utils/specs";
import { detectResources } from "../server/resources";
import { getStore } from "../server/store";

export async function resourcesCommand(system: string): Promise<void> {
  const spec = resolveSystemSpec(system);
  const resources = detectResources(spec.specPath);
  if (resources.length === 0) {
    log.warn(
      `No stateful resources detected in spec for ${system} (no collection ↔ /{id} pairs).`,
    );
    return;
  }
  const store = getStore(system);
  const counts = store.summary();

  console.log("");
  console.log(`${kleur.bold("Detected resources for")} ${kleur.cyan(system)}:`);
  for (const r of resources) {
    const n = counts[r.name] ?? 0;
    let pag: string;
    if (!r.pagination) pag = "(no pagination params declared)";
    else if (r.pagination.style === "page")
      pag = `page=${r.pagination.pageParam} size=${r.pagination.sizeParam}`;
    else if (r.pagination.style === "offset")
      pag = `offset=${r.pagination.offsetParam} limit=${r.pagination.limitParam}`;
    else
      pag = `cursor=${r.pagination.tokenParam} size=${r.pagination.sizeParam}`;

    const seed = r.exampleCollection?.length
      ? ` (+ ${r.exampleCollection.length} example record(s) from spec)`
      : "";
    const kind = r.itemPath ? "CRUD" : "list-only";

    console.log(
      `  • ${kleur.green(r.name).padEnd(20)} ${n} stored record(s)${seed}  ${kleur.gray("[" + kind + "]")}`,
    );
    console.log(`      collection : ${r.collectionPath}`);
    if (r.itemPath) {
      console.log(`      item       : ${r.itemPath}  (id param: ${r.idParam})`);
    }
    console.log(`      pagination : ${pag}`);
    if (r.envelope) {
      console.log(
        `      envelope   : { ${kleur.cyan(r.envelopeKey)}: [...], ${r.envelopeMeta.join(
          ", ",
        )} }`,
      );
    }
  }
  console.log("");
  log.dim(`Data file: data/${system}.json`);
}
