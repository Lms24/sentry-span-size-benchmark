"""Runs run.py for every variant in separate processes, ROUNDS times, alternating order.

Usage: python orchestrate.py   (use an interpreter that has urllib3 + certifi)
"""

import json
import os
import platform
import subprocess
import sys

from build_variants import VARIANTS

HERE = os.path.dirname(os.path.abspath(__file__))
ROUNDS = int(os.environ.get("ROUNDS", "7"))


def median(values):
    return sorted(values)[len(values) // 2]


def us(ns):
    return ("%.2f" if ns < 10_000 else "%.1f") % (ns / 1000)


def main():
    res = {}
    for r in range(ROUNDS):
        order = VARIANTS[::-1] if r % 2 else VARIANTS
        for v in order:
            raw = subprocess.check_output([sys.executable, os.path.join(HERE, "run.py"), v], cwd=HERE, text=True)
            for scenario, m in json.loads(raw)["out"].items():
                res.setdefault(scenario, {}).setdefault(v, []).append(m["median"])
        print("round %d/%d" % (r + 1, ROUNDS), file=sys.stderr)

    print("Python %s. Median µs per op; variants show (+added µs, +%%) vs `none`; ± = half range across rounds.\n" % platform.python_version())
    print("scenario".ljust(44) + "".join(v.rjust(28) for v in VARIANTS))
    for scenario, by_v in res.items():
        base = median(by_v["none"])
        cells = []
        for v in VARIANTS:
            m = median(by_v[v])
            spread = (max(by_v[v]) - min(by_v[v])) / 2
            delta = "" if v == "none" else " (%+.0f%%)" % ((m - base) / base * 100)
            cells.append(("%s ±%s%s" % (us(m), us(spread), delta)).rjust(28))
        print(scenario.ljust(44) + "".join(cells))


if __name__ == "__main__":
    main()
