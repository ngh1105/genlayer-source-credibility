/**
 * inspect.ts — dump the full GenLayer transaction/receipt for a deploy tx so we
 * can see (a) whether the deploy execution actually succeeded and (b) where the
 * real deployed contract address lives in the receipt shape.
 *
 * USAGE:
 *   GENLAYER_NETWORK=studionet TX=0x... npx tsx src/inspect.ts
 */

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import type { Hash } from "genlayer-js/types";

async function main(): Promise<void> {
  const tx = process.env.TX;
  if (!tx || !/^0x[0-9a-fA-F]+$/.test(tx)) {
    throw new Error("Set TX=0x... (a deploy transaction hash).");
  }

  const client = createClient({ chain: studionet });

  const receipt = await client.getTransaction({ hash: tx as Hash });
  console.log(JSON.stringify(receipt, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v, 2));
}

main().catch((err) => {
  console.error("inspect failed:", err);
  process.exitCode = 1;
});
