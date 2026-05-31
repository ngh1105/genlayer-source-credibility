/**
 * deploy.ts — deploy the Source Credibility Registry Intelligent Contract.
 *
 * Reads ../contracts/source_registry.py, deploys it to a GenLayer network,
 * waits for finalization, and prints the contract address.
 *
 * USAGE (after `npm install`):
 *   GENLAYER_PRIVATE_KEY=0x... \
 *   GENLAYER_NETWORK=studionet \
 *   npx tsx src/deploy.ts
 *
 * SECURITY: the deployer key is read from the environment and never written to
 * disk or committed. Use a throwaway/testnet key. Do not paste mainnet keys.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createClient, createAccount } from "genlayer-js";
import {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} from "genlayer-js/chains";
import { TransactionStatus, type Hash } from "genlayer-js/types";

// ---------------------------------------------------------------------------
// Network selection
// ---------------------------------------------------------------------------

const NETWORKS = {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} as const;

type NetworkName = keyof typeof NETWORKS;

function pickNetwork(): (typeof NETWORKS)[NetworkName] {
  const name = (process.env.GENLAYER_NETWORK ?? "studionet") as NetworkName;
  const chain = NETWORKS[name];
  if (!chain) {
    throw new Error(
      `Unknown GENLAYER_NETWORK="${name}". ` +
        `Valid: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function requirePrivateKey(): `0x${string}` {
  const key = process.env.GENLAYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "Set GENLAYER_PRIVATE_KEY to a 0x-prefixed 32-byte hex key (testnet only).",
    );
  }
  return key as `0x${string}`;
}

function readContractCode(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "..", "contracts", "source_registry.py");
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const chain = pickNetwork();
  const account = createAccount(requirePrivateKey());
  const code = readContractCode();

  console.log("Deploying Source Credibility Registry");
  console.log("  network:  ", process.env.GENLAYER_NETWORK ?? "studionet");
  console.log("  deployer: ", account.address);

  const client = createClient({ chain, account });

  const txHash = await client.deployContract({
    code,
    // Constructor: SourceRegistry.__init__(self) -> no args.
    args: [],
  });
  console.log("  deploy tx:", txHash);

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash as Hash,
    status: TransactionStatus.FINALIZED,
  });

  const address = (receipt as { contractAddress?: string }).contractAddress;
  if (!address) {
    throw new Error("Deployment finalized but no contract address was returned.");
  }

  console.log("\n✅ Deployed source_registry at:", address);
  console.log("   Export it for the client:");
  console.log(`   REGISTRY_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error("deploy failed:", err);
  process.exitCode = 1;
});
