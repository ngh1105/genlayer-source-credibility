/**
 * probe.ts — isolate whether studionet deploy+read works with a KNOWN-GOOD
 * minimal contract (contracts/probe_storage.py). Deploys, waits for finality,
 * then immediately reads get_storage() from the freshly-minted address.
 *
 * USAGE:
 *   GENLAYER_PRIVATE_KEY=0x... GENLAYER_NETWORK=studionet npx tsx src/probe.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus, type Address, type Hash } from "genlayer-js/types";

function requireKey(): `0x${string}` {
  const k = process.env.GENLAYER_PRIVATE_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("Set GENLAYER_PRIVATE_KEY (0x + 64 hex).");
  }
  return k as `0x${string}`;
}

function readCode(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, "..", "..", "contracts", "probe_storage.py"), "utf8");
}

async function main(): Promise<void> {
  const account = createAccount(requireKey());
  const client = createClient({ chain: studionet, account });

  console.log("Probe: deploy minimal Storage contract");
  const txHash = (await client.deployContract({
    code: readCode(),
    args: ["hello-studionet"],
  })) as Hash;
  console.log("  deploy tx:", txHash);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.FINALIZED,
  });
  const address = (receipt as { recipient?: string }).recipient as Address;
  console.log("  deployed at:", address);

  // Read back from the minted address, retrying to absorb any indexing lag
  // between consensus finality and the contract being queryable via gen_call.
  const MAX = 12;
  const DELAY_MS = 4000;
  let value: unknown;
  for (let i = 1; i <= MAX; i++) {
    try {
      value = await client.readContract({
        address,
        functionName: "get_storage",
        args: [],
      });
      console.log(`  attempt ${i}: get_storage =>`, JSON.stringify(value));
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  attempt ${i}/${MAX}: not yet readable (${msg.split("\n")[0]})`);
      if (i === MAX) throw err;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  console.log(value === "hello-studionet" ? "\n✅ deploy+read OK" : "\n⚠ unexpected value");
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exitCode = 1;
});
