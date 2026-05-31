# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# source_registry.py
# =============================================================================
# Source Credibility Registry — GenLayer Intelligent Contract (skeleton)
# =============================================================================
# A shared, on-chain public-good registry that scores the CREDIBILITY and
# LIVENESS of web sources (domains / specific routes) so that ANY Intelligent
# Oracle can query it BEFORE fetching, instead of hardcoding fragile URLs.
#
# Why this exists (the "World Wild Web" problem):
#   - Sources get paywalled, Cloudflare-blocked, rate-limited, or go offline.
#   - Malicious actors spin up fake/clone domains to poison oracle inputs.
#   - Oracles that hardcode a single URL are brittle and attackable.
#
# This registry is reusable infra. Other dApps call it to:
#   (a) check if a URL is currently reachable / live,
#   (b) read a 0..100 trust score,
#   (c) resolve to a vetted fallback source if the primary breaks.
#
# Consensus model:
#   - LIVENESS is a deterministic-ish boolean over a non-deterministic probe.
#     We use a CUSTOM equivalence principle: validators agree the source is
#     "up" if their independent renders agree on a reachable/non-empty result.
#   - CREDIBILITY is a fuzzy LLM judgement. We use the NON-COMPARATIVE prompt
#     equivalence principle so each validator scores against the SAME rubric
#     and the leader's output is accepted iff validators deem it reasonable.
#
# NOTE ON API SURFACE:
#   GenLayer's Python SDK (`genlayer`) is evolving. The decorators and
#   `gl.*` calls below mirror the documented intelligent-contract shape
#   (gl.public.write / gl.public.view, gl.nondet.web.render,
#   gl.nondet.exec_prompt, gl.eq_principle.*). Where a name might differ
#   across SDK versions it is flagged with `# ASSUMPTION:` so a reader can
#   reconcile against their installed version.
# =============================================================================

# The GenLayer runtime injects the `gl` module into GenVM contracts.
# (Importing it directly is the documented convention.)
from genlayer import *  # noqa: F401,F403  -> exposes gl, Contract, allow_storage, etc.

import json
import typing


# -----------------------------------------------------------------------------
# Domain constants
# -----------------------------------------------------------------------------

# Source lifecycle states. Stored as a short string for cheap on-chain reads.
STATUS_PENDING = "PENDING"        # registered, not yet assessed
STATUS_LIVE = "LIVE"              # reachable AND credible
STATUS_DEGRADED = "DEGRADED"      # reachable but stale / weak credibility
STATUS_OFFLINE = "OFFLINE"        # last liveness probe failed
STATUS_DEPRECATED = "DEPRECATED"  # retired by governance / superseded

# Score thresholds (0..100 scale).
SCORE_TRUSTED_MIN = 60   # at/above => usable by default
SCORE_DEGRADED_MIN = 35  # between degraded and trusted => DEGRADED
# below SCORE_DEGRADED_MIN while reachable => still DEGRADED but discouraged

# Time-decay: credibility loses confidence the longer since last check.
# Expressed as score points removed per full day since lastChecked, applied
# lazily at read time so we never need a cron/keeper to "tick" the registry.
DECAY_POINTS_PER_DAY = 5
SECONDS_PER_DAY = 86_400

# Cap on fallback chain length to bound gas + probe fan-out.
MAX_FALLBACKS = 5


# -----------------------------------------------------------------------------
# Stored record shape
# -----------------------------------------------------------------------------
# We keep per-source records in a TreeMap keyed by the normalized URL. Each
# record is a small dict serialized into storage. Using a dict keeps the
# skeleton readable; a production contract would use a typed storage struct.
#
# record = {
#   "url":          str,            # normalized canonical URL
#   "category":     str,            # logical bucket: price-feed | news | gov ...
#   "score":        int,            # 0..100 credibility (pre-decay, as last set)
#   "status":       str,            # one of STATUS_*
#   "lastChecked":  int,            # unix seconds of last liveness probe
#   "lastScored":   int,            # unix seconds of last credibility assessment
#   "fallbacks":    list[str],      # ordered alternative URLs
#   "registrant":   str,            # address that registered it
#   "probeCount":   int,            # how many liveness probes total
#   "failCount":    int,            # consecutive failed probes (for backoff)
# }
# -----------------------------------------------------------------------------


class SourceRegistry(gl.Contract):
    # --- storage -------------------------------------------------------------
    # ASSUMPTION: gl.storage TreeMap/Array primitives. Names mirror docs.
    sources: TreeMap[str, str]      # url -> json.dumps(record)
    index: DynArray[str]            # iterable list of known urls
    owner: Address                  # governance address (deprecate/override)

    def __init__(self) -> None:
        # Deployer becomes the governance owner. Governance is intentionally
        # minimal here (deprecate + override); real deployments would use a
        # multisig or DAO module on Base (see ARCHITECTURE.md).
        self.owner = gl.message.sender_address

    # =========================================================================
    # Helpers (pure, run on every node identically -> deterministic)
    # =========================================================================

    def _now(self) -> int:
        # ASSUMPTION: block timestamp exposed via gl.block / gl.message.
        # Falls back to 0 in environments that don't expose it (read-only sim).
        try:
            return int(gl.block.timestamp)  # type: ignore[attr-defined]
        except Exception:
            return 0

    def _normalize(self, url: str) -> str:
        # Canonicalize so "Example.com/" and "example.com" don't double-register.
        # Deterministic string ops only -> safe for consensus.
        u = url.strip().lower()
        if u.endswith("/"):
            u = u[:-1]
        return u

    def _load(self, url: str) -> typing.Optional[dict]:
        raw = self.sources.get(url)
        if raw is None or raw == "":
            return None
        return json.loads(raw)

    def _save(self, url: str, record: dict) -> None:
        existed = self.sources.get(url) is not None
        self.sources[url] = json.dumps(record)
        if not existed:
            self.index.append(url)

    def _effective_score(self, record: dict) -> int:
        # Apply lazy time-decay at read time. Never mutates storage.
        last = int(record.get("lastScored", 0))
        base = int(record.get("score", 0))
        if last <= 0:
            return base
        age_days = max(0, (self._now() - last) // SECONDS_PER_DAY)
        decayed = base - (age_days * DECAY_POINTS_PER_DAY)
        return max(0, min(100, decayed))

    def _derive_status(self, record: dict, reachable: bool) -> str:
        if record.get("status") == STATUS_DEPRECATED:
            return STATUS_DEPRECATED
        if not reachable:
            return STATUS_OFFLINE
        score = self._effective_score(record)
        if score >= SCORE_TRUSTED_MIN:
            return STATUS_LIVE
        return STATUS_DEGRADED

    def _public_view(self, record: dict) -> dict:
        # Shape returned to callers (matches frontend TrustedSource type).
        return {
            "url": record["url"],
            "score": self._effective_score(record),
            "status": record["status"],
            "lastChecked": int(record.get("lastChecked", 0)),
            "fallbacks": record.get("fallbacks", []),
        }

    # =========================================================================
    # WRITE: register_source
    # =========================================================================
    @gl.public.write
    def register_source(
        self,
        url: str,
        category: str,
        fallbacks: list[str] | None = None,
    ) -> None:
        """Register (or re-register) a web source.

        Pure on-chain bookkeeping: no network probe happens here, so this is a
        cheap, fully deterministic write. The new record starts PENDING with a
        neutral score until probe_liveness() + assess_credibility() run.

        Anyone may register; spam resistance comes from the scoring/decay model
        and optional registration fees on Base (see ARCHITECTURE threat model),
        not from a gatekept allowlist.
        """
        url = self._normalize(url)
        fallbacks = [self._normalize(f) for f in (fallbacks or [])][:MAX_FALLBACKS]

        existing = self._load(url)
        if existing is not None:
            # Re-registration updates category/fallbacks but preserves history
            # and score so a squatter can't reset a source's reputation.
            existing["category"] = category
            existing["fallbacks"] = fallbacks
            self._save(url, existing)
            return

        record = {
            "url": url,
            "category": category,
            "score": 50,                 # neutral prior until assessed
            "status": STATUS_PENDING,
            "lastChecked": 0,
            "lastScored": 0,
            "fallbacks": fallbacks,
            "registrant": str(gl.message.sender_address),
            "probeCount": 0,
            "failCount": 0,
        }
        self._save(url, record)

    # =========================================================================
    # WRITE: probe_liveness  (non-deterministic web render + CUSTOM eq principle)
    # =========================================================================
    @gl.public.write
    def probe_liveness(self, url: str) -> None:
        """Probe whether a source is currently reachable and serving content.

        Liveness is non-deterministic: each validator independently renders the
        URL and may see slightly different bytes (timestamps, ads, A/B tests).
        We collapse that to a BOOLEAN ('reachable + non-trivial body') and reach
        agreement with a CUSTOM equivalence principle: validators agree if their
        independent booleans match. This avoids requiring byte-identical pages.
        """
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            raise Exception("source not registered")

        def _probe() -> str:
            # Runs on each validator in a non-deterministic block.
            # ASSUMPTION: gl.nondet.web.render returns page text/markdown.
            page = gl.nondet.web.render(url, mode="text")  # type: ignore[attr-defined]
            body = (page or "").strip()
            reachable = len(body) >= 64  # non-trivial body => treat as up
            return json.dumps({"reachable": reachable, "len": len(body)})

        # CUSTOM equivalence principle: compare the leader's boolean to each
        # validator's boolean; equal booleans => equivalent. The comparator is
        # what makes liveness consensus tolerant of cosmetic page differences.
        def _eq(leader_out: str, validator_out: str) -> bool:
            a = json.loads(leader_out)
            b = json.loads(validator_out)
            return bool(a["reachable"]) == bool(b["reachable"])

        # ASSUMPTION: gl.eq_principle.custom(fn, comparator) is the documented
        # entry point for boolean/structured non-LLM consensus.
        result_json = gl.eq_principle.custom(_probe, _eq)  # type: ignore[attr-defined]
        result = json.loads(result_json)
        reachable = bool(result["reachable"])

        record["lastChecked"] = self._now()
        record["probeCount"] = int(record.get("probeCount", 0)) + 1
        if reachable:
            record["failCount"] = 0
        else:
            record["failCount"] = int(record.get("failCount", 0)) + 1
        record["status"] = self._derive_status(record, reachable)
        self._save(url, record)

    # =========================================================================
    # WRITE: assess_credibility  (LLM judge + NON-COMPARATIVE eq principle)
    # =========================================================================
    @gl.public.write
    def assess_credibility(self, url: str) -> None:
        """Score a source's credibility with an LLM judge.

        This is the fuzzy half of the registry. Each validator renders the page
        and runs the SAME rubric prompt; the NON-COMPARATIVE prompt equivalence
        principle accepts the leader's structured verdict iff validators agree
        it is a reasonable judgement of the same evidence. We do not require
        identical text, only that the score/flags are defensible.

        Credibility signals the judge weighs:
          - Is this the REAL domain or a likely clone/typosquat?
          - Does the content look fresh vs. stale/parked?
          - Are there integrity tells (TLS, structured data, author/date)?
          - Does the body match the declared `category`?
        """
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            raise Exception("source not registered")
        category = record.get("category", "unknown")

        def _judge() -> str:
            # Non-deterministic block: fetch fresh, then ask the model.
            # A registry that tracks LIVENESS must treat an unreachable or
            # non-renderable source as a graded OFFLINE signal, NOT a crash.
            try:
                page = gl.nondet.web.render(url, mode="text")  # type: ignore[attr-defined]
            except Exception:
                # Signal load failure as a structured verdict; all validators
                # rendering the same dead URL converge on the same outcome.
                return (
                    '{"score": 0, "real_domain": false, "fresh": false, '
                    '"clone_suspected": false, "load_failed": true, '
                    '"reason": "page could not be loaded"}'
                )
            snippet = (page or "")[:6000]  # bound prompt size
            prompt = f"""You are auditing a web source for an on-chain oracle.

URL: {url}
Declared category: {category}

PAGE CONTENT (truncated):
---
{snippet}
---

Score this source on a 0-100 CREDIBILITY scale using this rubric:
  - real_domain (is it the genuine source, not a clone/typosquat/parked page)
  - freshness   (is the content current, not stale or placeholder)
  - integrity   (author/date/structured data present, coherent, on-topic)
  - category_fit (content matches the declared category)

Return STRICT JSON only:
{{"score": <int 0-100>, "real_domain": <bool>, "fresh": <bool>,
  "clone_suspected": <bool>, "reason": "<one sentence>"}}"""
            # ASSUMPTION: gl.nondet.exec_prompt runs the model in nondet block.
            return gl.nondet.exec_prompt(prompt)  # type: ignore[attr-defined]

        # NON-COMPARATIVE: validators judge whether the leader's output is a
        # valid response to the SAME task, rather than diffing text byte-wise.
        # ASSUMPTION: gl.eq_principle.prompt_non_comparative(fn, task, criteria)
        verdict_json = gl.eq_principle.prompt_non_comparative(  # type: ignore[attr-defined]
            _judge,
            task="Audit the credibility of the given web source.",
            criteria=(
                "The JSON is well-formed; score is 0-100 and consistent with "
                "the flags; clone_suspected/real_domain are justified by the "
                "page content; the verdict is a reasonable audit of THIS url."
            ),
        )

        verdict = json.loads(verdict_json)

        # Graceful liveness handling: if the page could not be loaded, mark the
        # source OFFLINE and record the failure instead of scoring stale data.
        if bool(verdict.get("load_failed", False)):
            record["status"] = STATUS_OFFLINE
            record["failCount"] = int(record.get("failCount", 0)) + 1
            record["lastChecked"] = self._now()
            self._save(url, record)
            return

        score = max(0, min(100, int(verdict.get("score", 0))))
        clone = bool(verdict.get("clone_suspected", False))

        # A suspected clone is hard-capped regardless of other signals.
        if clone:
            score = min(score, 15)

        record["score"] = score
        record["lastScored"] = self._now()
        # Reachable assumption: we just rendered it, so treat as reachable
        # for status derivation unless a clone tanked the score.
        record["status"] = self._derive_status(record, reachable=True)
        self._save(url, record)

    # =========================================================================
    # READ: get_trusted_source
    # =========================================================================
    @gl.public.view
    def get_trusted_source(self, url: str) -> str:
        """Return the current trusted view for a URL as JSON.

        Read-only: no consensus round, no gas. Applies lazy time-decay so a
        source that hasn't been re-assessed slowly loses trust automatically.
        Returns a JSON string for SDK-version-tolerant decoding.
        """
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            return json.dumps({"found": False, "url": url})
        view = self._public_view(record)
        view["found"] = True
        return json.dumps(view)

    # =========================================================================
    # READ: resolve_with_fallback
    # =========================================================================
    @gl.public.view
    def resolve_with_fallback(self, url: str, min_score: int = SCORE_TRUSTED_MIN) -> str:
        """Return the best usable source at/above min_score, walking fallbacks.

        This is the call a consuming oracle makes right before fetching: hand it
        a logical primary URL and a trust floor, get back the first entry in
        {primary} + fallbacks that is non-OFFLINE, non-DEPRECATED, and meets the
        score floor (after decay). Falls back to the best-scoring candidate if
        none clear the floor, so the caller always gets an actionable answer.
        """
        url = self._normalize(url)
        primary = self._load(url)
        if primary is None:
            return json.dumps({"found": False, "url": url})

        candidates = [url] + [self._normalize(f) for f in primary.get("fallbacks", [])]
        best_view: dict | None = None
        best_score = -1

        for cand in candidates:
            rec = self._load(cand)
            if rec is None:
                # Unregistered fallback: surface it as PENDING so the caller
                # can choose to register/probe it.
                rec = {"url": cand, "score": 0, "status": STATUS_PENDING,
                       "lastChecked": 0, "lastScored": 0, "fallbacks": []}
            view = self._public_view(rec)
            usable = (
                view["status"] not in (STATUS_OFFLINE, STATUS_DEPRECATED)
                and view["score"] >= min_score
            )
            if usable:
                view["found"] = True
                view["resolved"] = cand
                return json.dumps(view)
            if view["score"] > best_score:
                best_score = view["score"]
                best_view = view

        # Nothing cleared the floor; return best-effort candidate.
        if best_view is None:
            return json.dumps({"found": False, "url": url})
        best_view["found"] = True
        best_view["resolved"] = best_view["url"]
        best_view["belowFloor"] = True
        return json.dumps(best_view)

    # =========================================================================
    # WRITE: governance — deprecate / override
    # =========================================================================
    @gl.public.write
    def deprecate_source(self, url: str) -> None:
        """Retire a source so resolve_with_fallback skips it. Owner-only.

        Used when a domain is confirmed compromised/clone or permanently dead.
        Non-destructive: the record is kept (audit trail) but marked DEPRECATED.
        """
        if gl.message.sender_address != self.owner:
            raise Exception("only owner may deprecate")
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            raise Exception("source not registered")
        record["status"] = STATUS_DEPRECATED
        self._save(url, record)

    @gl.public.write
    def override_score(self, url: str, score: int) -> None:
        """Governance escape hatch to hand-set a score (0-100). Owner-only.

        Intended for incident response (e.g. a known-good source the model
        keeps under-scoring, or a confirmed-bad one to zero out immediately).
        Refreshes lastScored so decay restarts from now.
        """
        if gl.message.sender_address != self.owner:
            raise Exception("only owner may override")
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            raise Exception("source not registered")
        record["score"] = max(0, min(100, int(score)))
        record["lastScored"] = self._now()
        record["status"] = self._derive_status(record, reachable=True)
        self._save(url, record)

    # =========================================================================
    # READ: enumeration helpers
    # =========================================================================
    @gl.public.view
    def list_sources(self) -> str:
        """Return all known source URLs as a JSON array (for dashboards)."""
        return json.dumps([self.index[i] for i in range(len(self.index))])

    @gl.public.view
    def get_record(self, url: str) -> str:
        """Return the full raw record (incl. registrant/counters) as JSON."""
        url = self._normalize(url)
        record = self._load(url)
        if record is None:
            return json.dumps({"found": False, "url": url})
        record = dict(record)
        record["found"] = True
        record["effectiveScore"] = self._effective_score(record)
        return json.dumps(record)
