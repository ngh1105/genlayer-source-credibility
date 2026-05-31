# conftest.py — test bootstrap for the Source Credibility Registry contract.
#
# source_registry.py does `from genlayer import *` at import time (GenVM-only).
# To unit-test its pure, deterministic helpers (URL normalization, lazy
# time-decay scoring, status derivation, public-view shaping) in plain CI, we
# inject a minimal stub `genlayer` module before import and expose contracts/.

import os
import sys
import types


def _install_genlayer_stub() -> None:
    if "genlayer" in sys.modules:
        return

    mod = types.ModuleType("genlayer")

    class _Public:
        @staticmethod
        def write(fn):
            return fn

        @staticmethod
        def view(fn):
            return fn

    def _eq_principle(*args, **kwargs):
        if args and callable(args[0]):
            return args[0]

        def _deco(fn):
            return fn

        return _deco

    class _Contract:
        """Stand-in base class for gl.Contract."""

    gl = types.SimpleNamespace()
    gl.Contract = _Contract
    gl.public = _Public()
    # Fixed timestamp so decay math in tests is deterministic.
    gl.message = types.SimpleNamespace(sender_account="0xStubGovernanceOwner")
    gl.block = types.SimpleNamespace(timestamp=1_900_000_000)
    gl.nondet = types.SimpleNamespace(
        web=types.SimpleNamespace(
            render=lambda *a, **k: {"status": 200, "body": "", "headers": {}}
        ),
        exec_prompt=lambda *a, **k: "",
    )
    gl.eq_principle = types.SimpleNamespace(
        strict_eq=_eq_principle,
        prompt_comparative=_eq_principle,
        prompt_non_comparative=_eq_principle,
    )

    class _Generic:
        def __class_getitem__(cls, _item):
            return cls

    mod.gl = gl
    mod.Contract = _Contract
    mod.TreeMap = _Generic
    mod.DynArray = _Generic
    mod.Address = str
    mod.allow_storage = lambda x: x
    mod.__all__ = [
        "gl",
        "Contract",
        "TreeMap",
        "DynArray",
        "Address",
        "allow_storage",
    ]

    sys.modules["genlayer"] = mod


_HERE = os.path.dirname(os.path.abspath(__file__))
_CONTRACTS = os.path.join(_HERE, "contracts")
if _CONTRACTS not in sys.path:
    sys.path.insert(0, _CONTRACTS)

_install_genlayer_stub()
