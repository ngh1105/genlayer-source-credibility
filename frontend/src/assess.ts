/**
 * assess.ts — exercise the LLM half of the registry on a DEPLOYED studionet
 * contract. Calls assess_credibility(url) (web.render + LLM judge + NON-
 * COMPARATIVE consensus), waits, then reads the record back to see the score
 * move off PENDING.
 *
 * NOTE: this triggers real LLM inference across validators, so it is slower and
 * may take several consensus rounds. We wait for FINALIZED here because the
 * non-deterministic verdict only settles once consensus on the judgement holds.
 *
 * USAGE:
 *   GENLAYER_PRIVATE_KEY=*** GENLAYER_NETWORK=studionet \
 *   REGISTRY_ADDRESS=0x... URL=https://... npx tsx src/assess.ts
 */

import { createClient, createAccount } from "genlayer-js";
import { studionet, localnet } from "genlayer-js/chains";
import { TransactionStatus, type Address, type Hash } from "genlayer-js/types";

const CHAIN = process.env.GENLAYER_NETWORK === "localnet" ? localnet : studionet;

const REGISTRY_ADDRESS = (process.env.REGISTRY_ADDRESS ??
  "0xaB57627f6D488365907F2D78e9141b48f1246Eee") as Address;

const URL = process.env.URL ?? "https://api.coingecko.com/api/v3/simple/price";

function requireKey(): `0x${string}` {
  const k = process.env.GENLAYER_PRIVATE_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("Set GENLAYER_PRIVATE_KEY (0x + 64 hex).");
  }
  return k as `0x${string}`;
}

function parse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function main(): Promise<void> {
  const account = createAccount(requireKey());
  const client = createClient({ chain: CHAIN, account });

  console.log("assess_credibility on", REGISTRY_ADDRESS);
  console.log("  url:", URL);

  const before = await client.readContract({
    address: REGISTRY_ADDRESS,
    functionName: "get_record",
    args: [URL],
  });
  console.log("  before:", JSON.stringify(parse(before)));

  console.log("\n→ assess_credibility (LLM judge across validators) ...");
  const txHash = (await client.writeContract({
    address: REGISTRY_ADDRESS,
    functionName: "assess_credibility",
    args: [URL],
    value: 0n,
  })) as Hash;
  console.log("  tx:", txHash);

  await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
  });
  console.log("  accepted ✅");

  const after = await client.readContract({
    address: REGISTRY_ADDRESS,
    functionName: "get_record",
    args: [URL],
  });
  console.log("\n  after:", JSON.stringify(parse(after), null, 2));
}

main().catch((err) => {
  console.error("assess failed:", err);
  process.exitCode = 1;
});
