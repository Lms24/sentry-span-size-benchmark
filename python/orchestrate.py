import json
import os
import platform
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = ["estimate", "exact_bytes", "exact_str_len"]
ROUNDS = 7


def median(values):
    return sorted(values)[len(values) // 2]


def main():
    res = {}
    for r in range(ROUNDS):
        order = CANDIDATES[::-1] if r % 2 else CANDIDATES
        for c in order:
            raw = subprocess.check_output(
                [sys.executable, os.path.join(HERE, "run.py"), c], cwd=HERE, text=True
            )
            for scenario, v in json.loads(raw)["out"].items():
                res.setdefault(scenario, {}).setdefault(c, []).append(v["median"])
        print("round %d/%d" % (r + 1, ROUNDS), file=sys.stderr)

    print("Python %s, %s" % (platform.python_version(), platform.platform()))
    print("scenario".ljust(14) + "".join(c.rjust(28) for c in CANDIDATES))
    for scenario, by_c in res.items():
        base = median(by_c["estimate"])
        cells = []
        for c in CANDIDATES:
            m = median(by_c[c])
            spread = (max(by_c[c]) - min(by_c[c])) / 2
            cells.append(("%.1fns ±%.1f %.1fx" % (m, spread, m / base)).rjust(28))
        print(scenario.ljust(14) + "".join(cells))


if __name__ == "__main__":
    main()
