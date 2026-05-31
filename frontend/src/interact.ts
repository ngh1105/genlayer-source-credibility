/**
 * interact.ts — end-to-end smoke against the DEPLOYED Source Credibility
 * Registry on studionet. Registers a source (write tx + consensus), then reads
 * it back via view calls. Unlike client.ts (a generic stub), this is wired to
 * the real genlayer-js 1.1.8 surface and a live contract address.
 *
 * USAGE (after `npm install`):
 *   GENLAYER_PRIVATE_KEY=0x...   (testnet/ephemeral key; never commit)
 *   GENLAYER_NETWORK=studionet
 *   REGISTRY_ADDRESS=0x...       (deployed address; falls back to known one)
 *   npx tsx src/interact.ts
 */

import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus, type Address, type Hash } from "genlayer-js/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Deployed registry on studionet (override via REGISTRY_ADDRESS). */
const REGISTRY_ADDRESS = (process.env.REGISTRY_ADDRESS ??
  "0xAb39F0Aca88DD25A814533e18D368290bE011aDE") as Address;

function requirePrivateKey(): `0x${string}` {
  const key = process.env.GENLAYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "Set GENLAYER_PRIVATE_KEY to a 0x-prefixed 32-byte hex key (testnet only).",
    );
  }
  return key as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** View calls return decoded JSON strings from the contract; parse defensively. */
function parseJson<T>(raw: unknown, label: string): T | string {
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`  (${label}: non-JSON return)`, raw);
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const account = createAccount(requirePrivateKey());
  const client = createClient({ chain: studionet, account });

  console.log("Source Credibility Registry — studionet smoke");
  console.log("  contract:", REGISTRY_ADDRESS);
  console.log("  caller:  ", account.address);

  const url = process.env.URL ?? "https://en.wikipedia.org/wiki/Bitcoin";
  const category = process.env.CATEGORY ?? "reference";
  const fallbacks = (process.env.FALLBACKS ??
    "https://www.coindesk.com,https://www.bbc.com/news")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // --- write: register_source ---------------------------------------------
  console.log("\n→ register_source:", url);
  const txHash = (await client.writeContract({
    address: REGISTRY_ADDRESS,
    functionName: "register_source",
    args: [url, category, fallbacks],
    value: 0n,
  })) as Hash;
  console.log("  tx:", txHash);

  await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
  });
  console.log("  accepted ✅");

  // --- read: get_record (full raw record) ---------------------------------
  console.log("\n→ get_record:", url);
  const record = await client.readContract({
    address: REGISTRY_ADDRESS,
    functionName: "get_record",
    args: [url],
  });
  console.log("  record:", JSON.stringify(parseJson(record, "get_record"), null, 2));

  // --- read: get_trusted_source (public view shape) ------------------------
  console.log("\n→ get_trusted_source:", url);
  const trusted = await client.readContract({
    address: REGISTRY_ADDRESS,
    functionName: "get_trusted_source",
    args: [url],
  });
  console.log("  trusted:", JSON.stringify(parseJson(trusted, "trusted"), null, 2));

  // --- read: list_sources (dashboard view) ---------------------------------
  console.log("\n→ list_sources");
  const all = await client.readContract({
    address: REGISTRY_ADDRESS,
    functionName: "list_sources",
    args: [],
  });
  console.log("  sources:", JSON.stringify(parseJson(all, "list_sources"), null, 2));

  console.log("\nDone. Note: score stays PENDING until assess_credibility() runs.");
}

main().catch((err) => {
  console.error("interact failed:", err);
  process.exitCode = 1;
});
