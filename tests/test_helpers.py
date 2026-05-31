# tests/test_helpers.py — unit tests for source_registry pure helpers.
#
# Imports the contract via the genlayer stub (conftest.py) and exercises ONLY
# deterministic, network-free logic: URL normalization, lazy time-decay,
# status derivation, and the public-view projection.

import pytest

import source_registry as reg
from source_registry import SourceRegistry


@pytest.fixture
def contract():
    # The stub base class has no real storage; construct without __init__ side
    # effects we don't need, then exercise pure methods that take explicit args.
    c = SourceRegistry.__new__(SourceRegistry)
    return c


# ---------------------------------------------------------------------------
# constants sanity
# ---------------------------------------------------------------------------

def test_threshold_ordering():
    assert reg.SCORE_DEGRADED_MIN < reg.SCORE_TRUSTED_MIN <= 100
    assert reg.DECAY_POINTS_PER_DAY > 0
    assert reg.SECONDS_PER_DAY == 86_400


# ---------------------------------------------------------------------------
# URL normalization
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://Example.com/", "https://example.com"),
        ("  https://example.com  ", "https://example.com"),
        ("HTTPS://API.EXAMPLE.COM/V3", "https://api.example.com/v3"),
        ("https://example.com", "https://example.com"),
    ],
)
def test_normalize(contract, raw, expected):
    assert contract._normalize(raw) == expected


# ---------------------------------------------------------------------------
# lazy time-decay scoring (_now is fixed at 1_900_000_000 via stub)
# ---------------------------------------------------------------------------

def test_effective_score_no_prior_assessment(contract):
    # lastScored == 0 => no decay, returns base score.
    rec = {"score": 80, "lastScored": 0}
    assert contract._effective_score(rec) == 80


def test_effective_score_decays_over_days(contract):
    now = contract._now()
    three_days_ago = now - 3 * reg.SECONDS_PER_DAY
    rec = {"score": 80, "lastScored": three_days_ago}
    # 80 - 3*DECAY_POINTS_PER_DAY
    assert contract._effective_score(rec) == 80 - 3 * reg.DECAY_POINTS_PER_DAY


def test_effective_score_clamped_at_zero(contract):
    now = contract._now()
    long_ago = now - 100 * reg.SECONDS_PER_DAY
    rec = {"score": 50, "lastScored": long_ago}
    assert contract._effective_score(rec) == 0


def test_effective_score_never_exceeds_100(contract):
    rec = {"score": 150, "lastScored": 0}
    # base passes through but is clamped at read elsewhere; here lastScored==0
    # returns base unchanged, so guard the clamp path with a fresh recent score.
    now = contract._now()
    rec2 = {"score": 150, "lastScored": now}
    assert contract._effective_score(rec2) == 100


# ---------------------------------------------------------------------------
# status derivation
# ---------------------------------------------------------------------------

def test_derive_status_deprecated_sticky(contract):
    rec = {"status": reg.STATUS_DEPRECATED, "score": 99, "lastScored": 0}
    assert contract._derive_status(rec, reachable=True) == reg.STATUS_DEPRECATED


def test_derive_status_offline_when_unreachable(contract):
    rec = {"status": reg.STATUS_LIVE, "score": 90, "lastScored": 0}
    assert contract._derive_status(rec, reachable=False) == reg.STATUS_OFFLINE


def test_derive_status_live_when_trusted(contract):
    rec = {"status": reg.STATUS_PENDING, "score": reg.SCORE_TRUSTED_MIN, "lastScored": 0}
    assert contract._derive_status(rec, reachable=True) == reg.STATUS_LIVE


def test_derive_status_degraded_below_threshold(contract):
    rec = {"status": reg.STATUS_PENDING, "score": reg.SCORE_TRUSTED_MIN - 1, "lastScored": 0}
    assert contract._derive_status(rec, reachable=True) == reg.STATUS_DEGRADED


# ---------------------------------------------------------------------------
# public view projection (matches frontend TrustedSource type)
# ---------------------------------------------------------------------------

def test_public_view_shape(contract):
    rec = {
        "url": "https://example.com",
        "score": 70,
        "status": reg.STATUS_LIVE,
        "lastChecked": 12345,
        "lastScored": 0,
        "fallbacks": ["https://alt.example.com"],
    }
    view = contract._public_view(rec)
    assert set(view.keys()) == {"url", "score", "status", "lastChecked", "fallbacks"}
    assert view["url"] == "https://example.com"
    assert view["score"] == 70
    assert view["status"] == reg.STATUS_LIVE
    assert view["lastChecked"] == 12345
    assert view["fallbacks"] == ["https://alt.example.com"]
