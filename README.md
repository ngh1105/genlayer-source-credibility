# Source Credibility Registry

A shared, on-chain public-good registry on **GenLayer** that scores the
**credibility** and **liveness** of web sources (domains and specific routes)
so that any Intelligent Oracle can query it **before** fetching — instead of
hardcoding fragile URLs.

> Think of it as DNS-meets-reputation for oracle inputs: a place to ask
> "is this source up, is it the real thing, and what should I use instead if
> it's down?" — and get an answer the whole network already agreed on.

---

## The problem: the "World Wild Web"

GenLayer's own writing on Intelligent Oracles calls out a hard truth: the open
web is a hostile, shifting input surface. Oracles that read it directly inherit
all of its fragility:

- **Sources disappear or change.** Endpoints get paywalled, rate-limited,
  Cloudflare-challenged, restructured, or simply go offline.
- **Hardcoded URLs rot.** An oracle that bakes in a single URL is one site
  redesign away from breaking, and has no Plan B.
- **Fake / clone domains.** Attackers spin up typosquats and cloned pages to
  feed poisoned data into oracles that don't verify *which* source they hit.
- **Staleness is invisible.** A page can return `200 OK` while serving
  months-old or parked content.

Every oracle team re-solves this badly and in isolation. This registry makes it
**shared infrastructure**: probe once, agree via consensus, reuse everywhere.

---

## What the registry stores

For each registered source (keyed by a normalized URL) it keeps a compact
record:

| Field          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `url`          | Normalized canonical URL (lowercased, trailing slash trimmed). |
| `category`     | Logical bucket: `price-feed`, `news`, `sports`, `gov`, ...     |
| `score`        | `0..100` credibility, as last assessed (pre-decay).            |
| `status`       | `PENDING` / `LIVE` / `DEGRADED` / `OFFLINE` / `DEPRECATED`.     |
| `lastChecked`  | Unix seconds of the last liveness probe.                       |
| `lastScored`   | Unix seconds of the last credibility assessment.               |
| `fallbacks`    | Ordered list of alternative URLs for the same logical source.  |
| `registrant`   | Address that registered the source.                            |
| `probeCount`   | Total liveness probes (observability).                         |
| `failCount`    | Consecutive failed probes (drives backoff / OFFLINE).          |

Status is **derived**, not just stored: reads apply lazy time-decay and
re-derive `LIVE` / `DEGRADED` from the effective score, so a source nobody has
re-assessed gradually loses trust without any keeper job ticking the contract.

---

## How other oracles consume it

A consuming Intelligent Oracle calls the registry **right before it fetches**:

```text
            ┌─────────────────────────────────────────────┐
            │  Consuming Oracle (e.g. a price/news oracle) │
            └───────────────┬─────────────────────────────┘
                            │ 1. resolve_with_fallback(url, minScore)
                            ▼
            ┌─────────────────────────────────────────────┐
            │        Source Credibility Registry          │
            │  - lazy decay applied at read time          │
            │  - walks primary + fallback chain           │
            │  - returns first LIVE source >= minScore    │
            └───────────────┬─────────────────────────────┘
                            │ 2. { url, score, status, ... }
                            ▼
            ┌─────────────────────────────────────────────┐
            │  Oracle fetches the RETURNED url, not its    │
            │  hardcoded one. If trust is low, it can      │
            │  refuse, widen sources, or flag the result.  │
            └─────────────────────────────────────────────┘
```

Three read patterns:

1. **`get_trusted_source(url)`** — "what's the current trust + status for this
   exact URL?" Returns score (post-decay), status, lastChecked, fallbacks.
2. **`resolve_with_fallback(url, minScore)`** — "give me the best usable URL for
   this logical source." Walks `primary + fallbacks`, returns the first entry
   that is non-`OFFLINE`, non-`DEPRECATED`, and clears `minScore`. If none
   clear the floor, returns the best-scoring candidate with `belowFloor: true`
   so the caller always gets an actionable answer.
3. **`get_record(url)` / `list_sources()`** — enumeration for dashboards.

Writes (`register_source`, `probe_liveness`, `assess_credibility`) can be driven
by anyone — registrants, the consuming oracle itself, or a community keeper —
and each goes through GenLayer consensus.

---

## Scoring model

Credibility is a single `0..100` score, produced and maintained in three steps:

1. **Prior.** A newly registered source starts at `50` (`PENDING`) — neutral,
   neither trusted nor distrusted.
2. **LLM assessment.** `assess_credibility()` renders the page and asks the
   model to score against a fixed rubric:
   - `real_domain` — is it the genuine source, not a clone / typosquat / parked
     page?
   - `freshness` — is the content current, not stale or placeholder?
   - `integrity` — author/date/structured data present, coherent, on-topic?
   - `category_fit` — does the content match the declared category?
   A **suspected clone is hard-capped at 15** regardless of other signals, so a
   convincing fake can't earn trust on polish alone.
3. **Lazy time-decay.** Reads subtract `DECAY_POINTS_PER_DAY` (default `5`) for
   each full day since `lastScored`. No keeper/cron is required — trust simply
   ages out until someone re-assesses, which keeps stale sources from looking
   permanently authoritative.

Status thresholds on the **effective** (post-decay) score:

- `>= 60` and reachable → **LIVE**
- `35..59` and reachable → **DEGRADED**
- last probe failed → **OFFLINE**
- governance-retired → **DEPRECATED**

Liveness is tracked separately from credibility: a source can be perfectly
reachable (`probe_liveness` passes) yet score low (clone/stale), or be highly
credible historically yet currently `OFFLINE`.

---

## Equivalence principle rationale

GenLayer reaches consensus over non-deterministic operations via an
**equivalence principle**. This registry deliberately uses two different ones,
matched to the nature of each output:

- **Liveness → custom (boolean) equivalence.**
  Each validator independently renders the URL; pages differ cosmetically
  (timestamps, ads, A/B variants), so byte-equality would fail constantly.
  We collapse each render to a single boolean — *reachable + non-trivial body* —
  and the custom comparator treats validators as in agreement when their
  booleans match. Robust liveness, tolerant of noise.

- **Credibility → non-comparative prompt equivalence.**
  Credibility is a fuzzy judgement, so we can't expect identical model output
  across validators. The non-comparative principle has each validator check
  whether the leader's structured verdict is a *reasonable* answer to the same
  task and rubric over the same evidence — not whether it is textually
  identical. This is the right tool for "is this a defensible audit?" rather
  than "are these strings equal?".

This split is the core design bet: **deterministic-style consensus for the
binary fact (up/down), judgement-style consensus for the opinion (trust).**

---

## Base (EVM L2) interaction

Settlement and contract logic live on **GenLayer**. **Base** is referenced as
the payment / registration rail:

- **Registration fees / anti-spam bonds** can be collected on Base and proven
  to the registry, raising the cost of Sybil domain spam without gatekeeping.
- **Governance** (the `owner` that can `deprecate_source` / `override_score`)
  is intended to graduate from a single key to a Base-based multisig or DAO.

The contract here keeps the Base coupling abstract (an `owner` address plus a
fee hook described in `ARCHITECTURE.md`) so the registry is usable without it.

---

## Limitations

- **Skeleton, not production.** `gl.*` calls mirror documented GenLayer APIs but
  are flagged with `# ASSUMPTION:` where names may differ across SDK versions.
  Validate against your installed `genlayer` package.
- **LLM judgement is imperfect.** A sophisticated clone may still fool the
  rubric; the hard-cap and governance override are mitigations, not guarantees.
- **Decay is linear and global.** A single rate fits all categories poorly — a
  price feed staleness window is minutes, a `gov` document's is months.
- **No on-chain proof of the fee rail yet.** The Base bond is described, not
  implemented end-to-end.
- **Probes cost consensus.** Liveness/assessment writes are not free; high-churn
  sources need a sensible re-probe cadence (see roadmap).

---

## Roadmap

- [ ] Per-category decay rates and trust floors.
- [ ] On-chain verification of a Base-paid registration bond.
- [ ] Keeper incentives: reward addresses that submit useful probes/assessments.
- [ ] Dispute / challenge flow to contest a score before deprecation.
- [ ] Reputation-weighted registrants (good history → cheaper registration).
- [ ] Batched multi-URL probes to amortize consensus cost.
- [ ] Reference adapter so existing oracles drop-in `resolve_with_fallback`.

---

## Repository layout

```text
.
├── README.md                     # this file
├── ARCHITECTURE.md               # components, integration, threat model
├── contracts/
│   └── source_registry.py        # GenLayer Intelligent Contract (skeleton)
├── frontend/
│   ├── package.json              # genlayer-js stub deps (no install performed)
│   ├── tsconfig.json
│   └── src/
│       └── client.ts             # register a source + query trust score
└── .gitignore
```

## Quick start (illustrative — no installs run during scaffolding)

```bash
# Contract: deploy with the GenLayer tooling / Studio against your node.
#   (see GenLayer docs for the deploy command for your SDK version)

# Frontend stub:
cd frontend
npm install            # pulls genlayer-js + ts tooling
GENLAYER_RPC=http://127.0.0.1:4000/api \
REGISTRY_ADDRESS=0xYourDeployedRegistry \
  npm run client       # registers a source, then queries its trust score
```
