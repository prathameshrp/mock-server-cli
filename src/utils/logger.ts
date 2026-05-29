import kleur from "kleur";

/**
 * All log helpers write to stderr so stdout stays reserved for intentional
 * data output (JSON payloads, raw header values, etc.). This makes shell
 * substitution like `TOKEN=$(npm run mock --silent -- token foo --raw)`
 * safe regardless of which informational messages a command happens to
 * emit on a given invocation.
 *
 * Commands that produce data MUST use process.stdout.write (or
 * console.log explicitly) for that data; the log.* helpers are for human
 * narration only.
 */
export const log = {
  info: (msg: string) => console.error(kleur.cyan("›"), msg),
  ok: (msg: string) => console.error(kleur.green("✓"), msg),
  warn: (msg: string) => console.error(kleur.yellow("!"), msg),
  err: (msg: string) => console.error(kleur.red("✗"), msg),
  step: (msg: string) => console.error(kleur.bold().white(msg)),
  dim: (msg: string) => console.error(kleur.gray(msg)),
};
