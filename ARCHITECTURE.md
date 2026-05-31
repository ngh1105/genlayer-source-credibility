# Architecture — Source Credibility Registry

This document covers the moving parts, how a consuming oracle integrates, the
scoring/decay model in detail, the threat model, and how GenLayer and Base
relate.

---

## 1. Components

```text
┌──────────────────────────────────────────────────────────────────────┐
│                              GenLayer                                  │
│                                                                        │
│   ┌──────────────────────────────┐    consensus over nondet ops       │
│   │   SourceRegistry (contract)  │◄───────────────────────────────┐   │
│   │                              │                                 │   │
│   │  state:  sources TreeMap     │                                 │   │
│   │          index   DynArray    │      ┌───────────────────────┐  │   │
│   │          owner   Address     │      │  GenVM validators     │  │   │
│   │                              │      │  - web.render()       │  │   │
│   │  write: register_source      │      │  - exec_prompt()      │──┘   │
│   │         probe_liveness   ────┼─────►│  - eq principle vote  │      │
│   │         assess_credibility ──┼─────►│                       │      │
│   │         deprecate/override   │      └───────────────────────┘      │
│   │  view:  get_trusted_source   │                                     │
│   │         resolve_with_fallback│                                     │
│   │         get_record/list      │                                     │
│   └──────────────┬───────────────┘                                     │
└──────────────────┼─────────────────────────────────────────────────────┘
                   │ reads (free) / writes (consensus)
   ┌───────────────┼───────────────────────────┐
   │               │                            │
┌──▼───────────┐ ┌─▼────────────────┐  ┌────────▼─────────────┐
│ Consuming    │ │ frontend/client  │  │ Community keeper /   │
│ Oracle dApp  │ │  (genlayer-js)   │  │ registrant scripts   │
│ resolve_…()  │ │ register + query │  │ periodic re-probe    │
└──────────────┘ └──────────────────┘  └──────────────────────┘

        ┌──────────────────────────────────────────────┐
        │                  Base (EVM L2)                │
        │  - registration bond / fee escrow             │
        │  - governance multisig / DAO (owner)          │
        └──────────────────────────────────────────────┘
```

**Contract (`contracts/source_registry.py`)** — the single source of truth.
Holds per-source records, applies decay lazily on read, and runs the two
non-deterministic operations (probe, assess) under GenLayer consensus.

**GenVM validators** — independently execute `web.render()` and `exec_prompt()`
inside non-deterministic blocks and vote via the equivalence principle.

**Consumers** — any oracle/dApp that calls the read methods before fetching.

**Keepers/registrants** — anyone who submits writes (register, probe, assess).
Optional incentives are on the roadmap.

**Base** — off-chain-to-GenLayer rail for fees/bonds and graduated governance.

---

## 2. How a consuming oracle integrates

The integration is intentionally one call deep. A consuming oracle that today
hardcodes a URL replaces that constant with a registry lookup.

### Call sequence (happy path)

```text
Oracle                         Registry                     GenLayer
  │                                │                            │
  │ resolve_with_fallback(url,60)  │                            │
  ├───────────────────────────────►                            │
  │                                │ load primary + fallbacks   │
  │                                │ apply lazy decay           │
  │                                │ pick first LIVE >= 60       │
  │ ◄──────────────────────────────                            │
  │   { resolved: urlB, score:78, status:"LIVE", ... }         │
  │                                                             │
  │ fetch(urlB)  ── normal oracle work, now pointed at a vetted, live source
  │                                                             │
  │ (optional) probe_liveness(urlB) / assess_credibility(urlB) │
  ├────────────────────────────────────────────────────────────►
  │     keeps the registry warm for the next consumer          │
```

### Integration rules of thumb

- **Read before every fetch.** Reads are free and apply fresh decay; cache only
  briefly.
- **Honor `status` and `belowFloor`.** If the registry returns `belowFloor:
  true`, the best available source is below your trust floor — refuse, widen
  sources, or attach a low-confidence flag rather than silently trusting it.
- **Give back what you learn.** After fetching, a good citizen calls
  `probe_liveness` / `assess_credibility` so later consumers benefit. This is
  the network effect that makes the registry a public good.
- **Register fallbacks generously.** The resolve path is only as resilient as
  the fallback chains people supply.

---

## 3. Scoring & decay model (detail)

### State machine

```text
         register_source
              │
              ▼
          ┌────────┐  assess (score>=60)   ┌────────┐
          │PENDING │ ─────────────────────► │  LIVE  │
          └────────┘                        └────────┘
              │                              ▲   │
  assess (35..59) │                  re-assess│   │ decay drops <60
              ▼                              │   ▼  OR assess 35..59
          ┌──────────┐ ◄─────────────────────┘ ┌──────────┐
          │ DEGRADED │ ───────────────────────►│ DEGRADED │
          └──────────┘                          └──────────┘
              │  probe fails                          │ probe fails
              ▼                                         ▼
          ┌─────────┐   probe ok + re-assess     ┌─────────┐
          │ OFFLINE │ ─────────────────────────► │  LIVE   │
          └─────────┘                            └─────────┘

   any state ── owner deprecate_source ──► DEPRECATED (terminal-ish)
```

### Effective score formula

```text
age_days        = floor((now - lastScored) / 86400)
effective_score = clamp(0, 100, score - age_days * DECAY_POINTS_PER_DAY)
```

- Computed **at read time** only; storage is never mutated by a read.
- `DECAY_POINTS_PER_DAY = 5` ⇒ a freshly-scored `80` decays to the `60`
  trust floor after 4 days, hitting `DEGRADED` thereafter until re-assessed.
- Clone hard-cap: `assess_credibility` clamps a suspected clone to `<=15`,
  which can never be `LIVE`/`DEGRADED`-trusted (below `35`).

### Why lazy decay

No keeper is required to "tick" the registry. Trust naturally erodes, so the
failure mode is **conservative** (a neglected source looks *less* trustworthy
over time, not falsely authoritative). Re-assessment resets the clock.

---

## 4. Threat model

| Threat | Vector | Mitigation in this design | Residual risk |
| ------ | ------ | ------------------------- | ------------- |
| **Sybil domain spam** | Attacker mass-registers junk/clone URLs to crowd dashboards or get one trusted. | Registration is cheap on-chain but yields a *neutral 50 PENDING* with no trust; trust only comes from an LLM assessment that checks `real_domain`/`clone_suspected`. Base-paid bond (roadmap) raises cost. | Volume spam still bloats `index`; needs bond + pagination. |
| **Clone / typosquat** | Pixel-perfect fake domain serving poisoned data. | Rubric explicitly scores `real_domain` and `clone_suspected`; a suspected clone is hard-capped at 15 and can be `deprecate`d by governance. | A flawless clone the model can't distinguish from origin. |
| **Score gaming** | Source serves clean content to validators during assessment, junk to real consumers. | Liveness + credibility are sampled at consensus time by independent validators; non-comparative principle requires multiple validators to agree the verdict is reasonable. | Time-of-check/time-of-use gap; cloaking by IP/UA. |
| **Stale liveness** | Source returns `200` with old/parked content. | `freshness` rubric signal + lazy decay degrade trust automatically; `assess_credibility` re-checks content, not just reachability. | Window between staleness onset and next assessment. |
| **Consensus manipulation** | Malicious validator pushes a bogus score/liveness. | Equivalence principles require agreement: custom boolean match for liveness, non-comparative reasonableness for credibility. | Standard GenLayer validator-set assumptions apply. |
| **Governance abuse** | `owner` maliciously deprecates/overrides. | `owner` is meant to be a Base multisig/DAO, not a single key; overrides are auditable on-chain and refresh `lastScored`. | Centralization until DAO migration. |
| **Resolve to bad fallback** | Primary down, fallback is itself compromised. | `resolve_with_fallback` enforces the same `minScore`/status checks on every candidate, not just the primary; unregistered fallbacks surface as `PENDING` (untrusted). | Fallbacks only as good as their own assessments. |

### Defensive defaults

- **Fail closed on trust:** `resolve_with_fallback` flags `belowFloor: true`
  rather than silently returning an untrusted source.
- **Non-destructive governance:** `deprecate_source` preserves the record
  (audit trail) instead of deleting it.
- **Reputation preservation:** re-registration cannot reset an existing
  source's score/history, so a squatter can't launder a bad reputation.

---

## 5. GenLayer ⇄ Base interaction

```text
   Registrant / Consumer                 Base (EVM L2)            GenLayer
        │                                     │                      │
        │ pay registration bond / fee         │                      │
        ├────────────────────────────────────►                      │
        │            (escrow / receipt)       │                      │
        │                                     │  proof of payment    │
        │                                     ├──────────────────────►
        │ register_source(url, category, ...) │                      │
        ├─────────────────────────────────────────────────────────► │
        │                                     │   (bond gates write) │
        │                                     │                      │
   Governance multisig/DAO on Base ── owner ──┼──► deprecate/override │
```

- **Settlement & logic:** GenLayer (the contract, consensus, web/LLM ops).
- **Payment & governance rail:** Base, for anti-spam bonds and a credible-
  neutral `owner`.
- The contract keeps this coupling abstract: today it enforces an `owner`
  address and documents a fee hook; wiring the Base bond proof end-to-end is
  on the roadmap.

---

## 6. File map

| Path | Role |
| ---- | ---- |
| `contracts/source_registry.py` | Intelligent Contract: state, probe, assess, resolve, governance. |
| `frontend/src/client.ts` | genlayer-js stub: register a source, query trust, resolve fallback. |
| `frontend/package.json` / `tsconfig.json` | Stub tooling (no install performed). |
| `README.md` | Problem, storage, consumption, scoring, eq-principle rationale. |
| `ARCHITECTURE.md` | This document. |
