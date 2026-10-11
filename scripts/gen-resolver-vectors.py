#!/usr/bin/env python3
"""Generate src/detector/resolver-vectors.json from the brain's REAL resolver.

The TypeScript port in src/detector/resolve-pair.ts is checked against these vectors, so the
port is measured against the function the hosted product runs, not against a reading of it.

Run it with the interpreter the brain image runs (services/brain/Dockerfile: python:3.14),
because datetime.fromisoformat differs between versions (24:00 is accepted from 3.12 on in the
C implementation but differed in earlier review runs); the file records the version used.

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
    # Review F4 (2026-10-11): inputs where a hand-written port can drift from CPython's own
    # datetime.fromisoformat, str.strip, str.lower and dict.get.
    ("equal timestamps, claim names b -> conflicts_with", side("a", T0, "D"), side("b", T0, "D"), "b"),
    ("both dates missing", side("a"), side("b"), "b"),
    ("leading space in decided_at is not trimmed", side("a", " 2026-01-01T00:00:00Z", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("trailing newline in decided_at is not trimmed", side("a", "2026-01-01T00:00:00Z\n", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("offset without colon", side("a", "2026-01-01T00:00:00+0100", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("lowercase z", side("a", "2026-01-01T00:00:00z", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("basic format", side("a", "20260101T000000Z", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("hour only", side("a", "2026-01-01T05", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("year 0050", side("a", "0050-01-01", "D"), side("b", "2026-01-05", "D"), None),
    ("year 0001 vs 0002", side("a", "0001-01-01", "D"), side("b", "0002-01-01", "D"), None),
    ("7 fraction digits", side("a", "2026-01-01T00:00:00.1234567Z", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("sub-millisecond gap just past 24h", side("a", "2026-01-01T00:00:00.000000Z", "D"), side("b", "2026-01-02T00:00:00.000400Z", "D"), None),
    ("one microsecond past 24h", side("a", "2026-01-01T00:00:00Z", "D"), side("b", "2026-01-02T00:00:00.000001Z", "D"), None),
    ("offset with seconds", side("a", "2026-01-01T00:00:00+01:00:30", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("Z and +00:00 are the same instant", side("a", "2026-01-01T00:00:00+00:00", "D"), side("b", "2026-01-01T00:00:00Z", "D"), None),
    ("week date", side("a", "2026-W01-1", "D"), side("b", "2026-02-05", "D"), None),
    ("compact week date", side("a", "2026W011", "D"), side("b", "2026-02-05", "D"), None),
    ("24:00 is midnight of the next day", side("a", "2026-01-01T24:00:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("24:00 boundary: 24:00 vs next day +24h exactly", side("a", "2026-01-01T24:00:00Z", "D"), side("b", "2026-01-03T00:00:00Z", "D"), None),
    ("24:01 is invalid", side("a", "2026-01-01T24:01:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("second 60 is invalid", side("a", "2026-01-01T00:00:60", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("29 February in a non-leap year is invalid", side("a", "2025-02-29", "D"), side("b", "2025-03-05", "D"), None),
    ("any single character separates date and time", side("a", "2026-01-01X00:00:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("comma fraction separator", side("a", "2026-01-01T00:00:00,5", "D"), side("b", "2026-01-02T00:00:00,6", "D"), None),
    ("offset of 24 hours is invalid", side("a", "2026-01-01T00:00:00+24:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("negative offset moves the instant later", side("a", "2026-01-01T00:00:00-02:00", "D"), side("b", "2026-01-02T01:00:00Z", "D"), None),
    ("standing __proto__ later vs human earlier, claim", side("a", T0, None, standing="human"), side("b", "2026-01-05T00:00:00Z", None, standing="__proto__"), "b"),
    ("standing toString later vs human earlier, same author", side("a", T0, "D", standing="human"), side("b", "2026-01-05T00:00:00Z", "D", standing="toString"), None),
    ("standing HUMAN in upper case is unknown", side("a", T0, "D", standing="ratified_agent"), side("b", "2026-01-05T00:00:00Z", "D", standing="HUMAN"), None),
    ("exempt and retired", side("a", T0, "D", status="superseded", excepted_by=("b",)), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("exemption naming itself does not exempt the pair", side("a", T0, "D", excepted_by=("a",)), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("claim with a U+FEFF prefix is not stripped", side("a", T0), side("b", "2026-01-05T00:00:00Z"), "\ufeffb"),
    ("claim with a no-break space is stripped", side("a", T0), side("b", "2026-01-05T00:00:00Z"), "\u00a0b"),
    ("claim with a U+001F prefix is stripped (Python whitespace)", side("a", T0), side("b", "2026-01-05T00:00:00Z"), "\u001fb"),
    ("author with a no-break space", side("a", T0, "\u00a0Dana"), side("b", "2026-01-05T00:00:00Z", "dana"), None),
    ("author: STRASSE vs strasse-with-eszett differ", side("a", T0, "STRASSE"), side("b", "2026-01-05T00:00:00Z", "stra\u00dfe"), None),
    ("author: dotted capital I lowers to i plus combining dot", side("a", T0, "\u0130lker"), side("b", "2026-01-05T00:00:00Z", "i\u0307lker"), None),
    ("author with a U+001F prefix is stripped (Python whitespace, not JS)", side("a", T0, "\u001fDana"), side("b", "2026-01-05T00:00:00Z", "dana"), None),
    ("author with a U+FEFF prefix is not stripped", side("a", T0, "\ufeffDana"), side("b", "2026-01-05T00:00:00Z", "dana"), None),
    ("week date in a year starting on Friday: 2027-W01-1 is 4 January", side("a", "2027-W01-1", "D"), side("b", "2027-01-04T12:00:00", "D"), None),
    # Re-review R1: a separator with nothing after it, or one stray character, is no date in Python.
    ("date then a trailing space is no date", side("a", "2026-01-01 ", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("date then a bare T is no date", side("a", "2026-01-01T", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("date then one stray letter is no date", side("a", "2026-01-01x", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("week date then a trailing space is no date", side("a", "2026-W01-1 ", "D"), side("b", "2026-02-05T00:00:00Z", "D"), None),
    ("one stray character right before an offset is tolerated", side("a", "2026-01-01T00:00:00x+00:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("a decimal mark right before an offset is not", side("a", "2026-01-01T00:00:00.+00:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("a non-ASCII separator is allowed", side("a", "2026-01-01\u00e910:00", "D"), side("b", "2026-01-05T00:00:00Z", "D"), None),
    ("status Superseded in title case is not retired", side("a", T0, "D", status="Superseded"), side("b", "2026-01-05T00:00:00Z", "D"), None),
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
        "python": sys.version.split()[0],
        "cases": out,
    }, indent=2))


if __name__ == "__main__":
    main()
