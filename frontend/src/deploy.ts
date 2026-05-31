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

function readContractCode(): Uint8Array {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "..", "contracts", "source_registry.py");
  // GenLayer expects raw bytes for the contract module, not a UTF-8 string.
  return new Uint8Array(readFileSync(path));
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

  // Required before deploying on studionet/testnet.
  await client.initializeConsensusSmartContract();

  const txHash = await client.deployContract({
    code,
    // Constructor: SourceRegistry.__init__(self) -> no args.
    args: [],
  });
  console.log("  deploy tx:", txHash);

  // Contracts are queryable at ACCEPTED (optimistic state); FINALIZED is slower
  // and not required to read state.
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash as Hash,
    status: TransactionStatus.ACCEPTED,
  });

  if (process.env.DUMP_RECEIPT === "1") {
    console.log("\n--- full receipt ---");
    console.log(
      JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    );
    console.log("--- end receipt ---\n");
  }

  // Address derivation differs by network (per official deployScript.ts):
  //  - localnet:           receipt.data.contract_address
  //  - studionet/testnet:  receipt.txDataDecoded.contractAddress
  const r = receipt as {
    data?: { contract_address?: string };
    txDataDecoded?: { contractAddress?: string };
    recipient?: string;
  };
  const isLocal = chain.id === localnet.id;
  const address = isLocal
    ? r.data?.contract_address
    : r.txDataDecoded?.contractAddress ?? r.recipient;
  if (!address) {
    console.log("\n⚠ Accepted but address field not found. Raw receipt:");
    console.log(JSON.stringify(receipt, null, 2));
    throw new Error("Deployment accepted but no contract address was returned.");
  }

  console.log("\n✅ Deployed source_registry at:", address);
  console.log("   Export it for the client:");
  console.log(`   REGISTRY_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error("deploy failed:", err);
  process.exitCode = 1;
});
