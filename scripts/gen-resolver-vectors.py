#!/usr/bin/env python3
"""Generate src/detector/resolver-vectors.json from the brain's REAL resolver.

The TypeScript port in src/detector/resolve-pair.ts is checked against these vectors, so the
port is measured against the function the hosted product runs, not against a reading of it.

Usage (no network, pure stdlib; the brain module imports only dataclasses and datetime):
  git -C <align-stack> show origin/main:services/brain/app/relationship_type_rules.py > /tmp/rtr.py
  python3 scripts/gen-resolver-vectors.py --source /tmp/rtr.py --commit <align-stack sha> > src/detector/resolver-vectors.json

Inputs are hand-written and carry no customer text.
"""
import argparse
import hashlib
import importlib.util
import json
import sys


def side(id, decided_at=None, author=None, status=None, standing=None, excepted_by=()):
    return {"id": id, "decided_at": decided_at, "author": author, "status": status,
            "standing": standing, "excepted_by": list(excepted_by)}


T0 = "2026-01-01T00:00:00Z"
CASES = [
    # name, a, b, explicit_replacement_by
    ("30h apart, same author -> supersedes later->earlier",
     side("a", T0, "Dana"), side("b", "2026-01-02T06:00:00Z", "Dana"), None),
    ("30h apart, same author, argument order swapped",
     side("b", "2026-01-02T06:00:00Z", "Dana"), side("a", T0, "Dana"), None),
    ("30h apart, different authors, replaced names the later side -> supersedes",
     side("a", T0, "Dana"), side("b", "2026-01-02T06:00:00Z", "Lee"), "b"),
    ("30h apart, different authors, replaced names the earlier side -> conflicts_with",
     side("a", T0, "Dana"), side("b", "2026-01-02T06:00:00Z", "Lee"), "a"),
    ("30h apart, different authors, no claim -> conflicts_with",
     side("a", T0, "Dana"), side("b", "2026-01-02T06:00:00Z", "Lee"), None),
    ("30h apart, both authors unknown, no claim -> conflicts_with (unknown is never same)",
     side("a", T0), side("b", "2026-01-02T06:00:00Z"), None),
    ("30h apart, both authors the sentinel Unknown -> conflicts_with",
     side("a", T0, "Unknown"), side("b", "2026-01-02T06:00:00Z", " unknown "), None),
    ("30h apart, same author differing only in case and spaces -> supersedes",
     side("a", T0, " Dana "), side("b", "2026-01-02T06:00:00Z", "dana"), None),
    ("23h apart, same author -> conflicts_with",
     side("a", T0, "Dana"), side("b", "2026-01-01T23:00:00Z", "Dana"), None),
    ("exactly 24h apart, same author -> conflicts_with",
     side("a", T0, "Dana"), side("b", "2026-01-02T00:00:00Z", "Dana"), None),
    ("24h plus 1s apart, same author -> supersedes",
     side("a", T0, "Dana"), side("b", "2026-01-02T00:00:01Z", "Dana"), None),
    ("24h plus 1s apart, claim names later side, authors unknown -> supersedes",
     side("a", T0), side("b", "2026-01-02T00:00:01Z"), "b"),
    ("claim with surrounding spaces still names the later side",
     side("a", T0), side("b", "2026-01-03T00:00:00Z"), " b "),
    ("a retired (superseded) -> no edge",
     side("a", T0, "Dana", status="superseded"), side("b", "2026-01-03T00:00:00Z", "Dana"), None),
    ("b retired (archived) -> no edge",
     side("a", T0, "Dana"), side("b", "2026-01-03T00:00:00Z", "Dana", status="archived"), None),
    ("b retired (corrected) -> no edge",
     side("a", T0, "Dana"), side("b", "2026-01-03T00:00:00Z", "Dana", status="corrected"), None),
    ("status active and conflicted are not retired",
     side("a", T0, "Dana", status="conflicted"), side("b", "2026-01-03T00:00:00Z", "Dana", status="active"), None),
    ("a decided_at missing -> conflicts_with",
     side("a", None, "Dana"), side("b", "2026-01-03T00:00:00Z", "Dana"), "b"),
    ("b decided_at missing -> conflicts_with",
     side("a", T0, "Dana"), side("b", None, "Dana"), "b"),
    ("b decided_at unparseable -> conflicts_with",
     side("a", T0, "Dana"), side("b", "not a date", "Dana"), "b"),
    ("naive timestamps are UTC",
     side("a", "2026-01-01T00:00:00", "Dana"), side("b", "2026-01-02T00:00:01", "Dana"), None),
    ("offset timestamps compare as instants: 24h on the wall clock, 25h as instants -> supersedes",
     side("a", "2026-01-01T00:00:00+01:00", "Dana"), side("b", "2026-01-02T00:00:00Z", "Dana"), None),
    ("offset timestamps compare as instants: 25h on the wall clock, 24h as instants -> conflicts_with",
     side("a", "2026-01-01T00:00:00-01:00", "Dana"), side("b", "2026-01-02T01:00:00Z", "Dana"), None),
    ("date-only values",
     side("a", "2026-01-01", "Dana"), side("b", "2026-01-03", "Dana"), None),
    ("space separator and fractional seconds",
     side("a", "2026-01-01 00:00:00.250", "Dana"), side("b", "2026-01-02 00:00:00.500", "Dana"), None),
    ("exemption on either side -> no edge",
     side("a", T0, "Dana", excepted_by=("b",)), side("b", "2026-01-03T00:00:00Z", "Dana"), None),
    ("exemption the other way -> no edge",
     side("a", T0, "Dana"), side("b", "2026-01-03T00:00:00Z", "Dana", excepted_by=("a",)), None),
    ("lower standing may not retire higher: later unratified agent vs earlier human -> conflicts_with",
     side("a", T0, "Dana", standing="human"), side("b", "2026-01-03T00:00:00Z", "Dana", standing="unratified_agent"), None),
    ("higher standing may retire lower: later human vs earlier agent -> supersedes",
     side("a", T0, "Dana", standing="unratified_agent"), side("b", "2026-01-03T00:00:00Z", "Dana", standing="human"), None),
    ("no standing on either side resolves as equal standing (local mode) -> supersedes",
     side("a", T0, "Dana"), side("b", "2026-01-03T00:00:00Z", "Dana"), None),
    ("no standing on the later side vs a human earlier side -> conflicts_with",
     side("a", T0, "Dana", standing="human"), side("b", "2026-01-03T00:00:00Z", "Dana"), None),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--commit", required=True)
    args = ap.parse_args()
    raw = open(args.source, "rb").read()
    spec = importlib.util.spec_from_file_location("rtr", args.source)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["rtr"] = mod  # dataclasses resolves the module by name
    spec.loader.exec_module(mod)

    def to_side(s):
        return mod.PairSide(id=s["id"], decided_at=mod.parse_decided_at(s["decided_at"]),
                            author=mod.normalize_author(s["author"]), status=s["status"],
                            excepted_by=tuple(s["excepted_by"]), standing=s["standing"])

    out = []
    for name, a, b, claim in CASES:
        r = mod.resolve_incompatible_pair(to_side(a), to_side(b), explicit_replacement_by=claim)
        out.append({"name": name, "a": a, "b": b, "replacedBy": claim,
                    "expected": None if r is None else {"type": r.type, "fromId": r.from_id, "toId": r.to_id}})
    print(json.dumps({
        "note": "Generated by scripts/gen-resolver-vectors.py from the brain's resolve_incompatible_pair. Do not hand-edit.",
        "source": "services/brain/app/relationship_type_rules.py",
        "sourceCommit": args.commit,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "concurrentWindowHours": mod.CONCURRENT_WINDOW_HOURS,
        "cases": out,
    }, indent=2))


if __name__ == "__main__":
    main()
