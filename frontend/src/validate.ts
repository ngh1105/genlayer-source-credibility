/**
 * validate.ts — validate a contract in GenVM WITHOUT deploying, via
 * client.getContractSchemaForCode(). On studionet this calls
 * gen_getContractSchemaForCode. If it returns a schema, the code+header are
 * accepted by this network's GenVM; if it errors, the message pinpoints why
 * (e.g. runner/Depends tag, missing contract class) — the same cause behind a
 * deploy that finalizes with execution_result=ERROR "invalid_contract".
 *
 * USAGE:
 *   GENLAYER_NETWORK=studionet FILE=probe_storage.py npx tsx src/validate.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createClient } from "genlayer-js";
import { studionet, localnet } from "genlayer-js/chains";

const CHAIN = process.env.GENLAYER_NETWORK === "localnet" ? localnet : studionet;

function readCode(): Uint8Array {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = process.env.FILE ?? "probe_storage.py";
  return new Uint8Array(readFileSync(resolve(here, "..", "..", "contracts", file)));
}

async function main(): Promise<void> {
  const client = createClient({ chain: CHAIN });
  const code = readCode();
  console.log("validate:", process.env.FILE ?? "probe_storage.py", "on", CHAIN.id);
  try {
    const schema = await client.getContractSchemaForCode(code);
    console.log("✅ schema OK:");
    console.log(JSON.stringify(schema, null, 2).slice(0, 1200));
  } catch (err) {
    console.log("❌ schema error:");
    console.log(err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  console.error("validate crashed:", err);
  process.exitCode = 1;
});
