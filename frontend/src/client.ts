/**
 * Source Credibility Registry — genlayer-js client stub
 * ------------------------------------------------------
 * Minimal, install-free TypeScript example showing how a consuming app
 * (e.g. another Intelligent Oracle's off-chain helper, or a dApp UI)
 * talks to the on-chain Source Credibility Registry.
 *
 * It demonstrates two flows:
 *   1) register_source(...)        — write tx (state changing)
 *   2) get_trusted_source(...)     — read call (view)
 *
 * This is a SKELETON. The genlayer-js surface used here mirrors the
 * public client shape (createClient / writeContract / readContract).
 * Exact names/signatures may drift across SDK versions — see TODOs.
 * Do NOT expect this to run without `npm install` + a live endpoint.
 */

// NOTE: import path is illustrative. genlayer-js re-exports a client
// factory plus chain presets. Adjust to the version you install.
import { createClient, type GenLayerClient } from "genlayer-js";
// import { studionet, localnet } from "genlayer-js/chains"; // chain presets

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Deployed registry contract address (GenLayer account address). */
const REGISTRY_ADDRESS =
  (process.env.REGISTRY_ADDRESS as `0x${string}`) ??
  ("0x0000000000000000000000000000000000000000" as const);

/** RPC endpoint for a GenLayer node (Studionet / Localnet / your node). */
const RPC_URL = process.env.GENLAYER_RPC ?? "http://127.0.0.1:4000/api";

// ---------------------------------------------------------------------------
// Client bootstrap
// ---------------------------------------------------------------------------

/**
 * Build a GenLayer client. In genlayer-js you typically pass a `chain`
 * preset and (for writes) an account/signer. Here we keep it generic and
 * comment the shape so the example stays version-tolerant.
 */
function makeClient(): GenLayerClient<any> {
  // TODO(sdk): replace `{ endpoint: RPC_URL }` with the real chain preset,
  // e.g. createClient({ chain: studionet }) and inject an account for writes.
  const client = createClient({
    // chain: studionet,
    endpoint: RPC_URL,
    // account: privateKeyToAccount(process.env.GENLAYER_PRIVATE_KEY!),
  } as any);
  return client as GenLayerClient<any>;
}

// ---------------------------------------------------------------------------
// Types mirroring the contract's public shapes (kept loose on purpose)
// ---------------------------------------------------------------------------

/** Status enum mirrored from contracts/source_registry.py. */
export type SourceStatus =
  | "PENDING" // registered, not yet assessed
  | "LIVE" // reachable + credible
  | "DEGRADED" // reachable but stale / partially credible
  | "OFFLINE" // last probe failed
  | "DEPRECATED"; // retired by governance / superseded

/** Shape returned by get_trusted_source / resolve_with_fallback. */
export interface TrustedSource {
  url: string;
  score: number; // 0..100 credibility score
  status: SourceStatus;
  lastChecked: number; // unix seconds of last probe
  fallbacks: string[]; // ordered alternative URLs
}

// ---------------------------------------------------------------------------
// Write flow: register a source
// ---------------------------------------------------------------------------

/**
 * Register (or re-register) a web source in the registry.
 * State-changing => goes through a transaction + GenLayer consensus.
 */
export async function registerSource(
  client: GenLayerClient<any>,
  args: {
    url: string;
    category: string; // e.g. "price-feed" | "news" | "sports" | "gov"
    fallbacks?: string[]; // ordered alternates probed if primary breaks
  },
): Promise<string> {
  // TODO(sdk): writeContract signature differs slightly by version.
  const txHash = await (client as any).writeContract({
    address: REGISTRY_ADDRESS,
    functionName: "register_source",
    args: [args.url, args.category, args.fallbacks ?? []],
    value: 0n,
  });

  // Wait for the tx to be accepted/finalized by the network.
  // TODO(sdk): method may be waitForTransactionReceipt / getTransaction.
  await (client as any).waitForTransactionReceipt?.({
    hash: txHash,
    status: "FINALIZED",
  });

  return txHash as string;
}

// ---------------------------------------------------------------------------
// Read flow: query the trust score / trusted source
// ---------------------------------------------------------------------------

/**
 * Read the current trusted view for a URL. Read-only => no gas, no consensus
 * round; served from the latest accepted state.
 */
export async function getTrustedSource(
  client: GenLayerClient<any>,
  url: string,
): Promise<TrustedSource> {
  const result = await (client as any).readContract({
    address: REGISTRY_ADDRESS,
    functionName: "get_trusted_source",
    args: [url],
  });
  return result as TrustedSource;
}

/**
 * Ask the registry to hand back the best live URL for a logical source,
 * walking the fallback chain if the primary is OFFLINE/DEGRADED.
 * This is the call a consuming oracle should make right before fetching.
 */
export async function resolveWithFallback(
  client: GenLayerClient<any>,
  url: string,
  minScore = 60,
): Promise<TrustedSource> {
  const result = await (client as any).readContract({
    address: REGISTRY_ADDRESS,
    functionName: "resolve_with_fallback",
    args: [url, minScore],
  });
  return result as TrustedSource;
}

// ---------------------------------------------------------------------------
// Demo / smoke entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = makeClient();

  const primary = "https://api.coingecko.com/api/v3/simple/price";

  console.log("→ Registering source:", primary);
  try {
    const tx = await registerSource(client, {
      url: primary,
      category: "price-feed",
      fallbacks: [
        "https://api.coinbase.com/v2/prices/BTC-USD/spot",
        "https://api.kraken.com/0/public/Ticker",
      ],
    });
    console.log("  registered, tx:", tx);
  } catch (err) {
    console.warn("  register skipped (stub / no endpoint):", String(err));
  }

  console.log("→ Querying trust score for:", primary);
  try {
    const trusted = await getTrustedSource(client, primary);
    console.log("  trust:", JSON.stringify(trusted, null, 2));

    if (trusted.status !== "LIVE" || trusted.score < 60) {
      console.log("→ Primary not trustworthy, resolving fallback...");
      const best = await resolveWithFallback(client, primary, 60);
      console.log("  use this URL:", best.url, "(score", best.score + ")");
    }
  } catch (err) {
    console.warn("  read skipped (stub / no endpoint):", String(err));
  }
}

// Only run when executed directly (not when imported as a module).
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /client\.(ts|js)$/.test(process.argv[1] ?? "");

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
