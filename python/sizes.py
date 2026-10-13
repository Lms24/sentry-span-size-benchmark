import random

from spans import SCENARIOS, make_pool
from vendored import estimate_size, json_dumps, to_transport_format

random.seed(1)
print("scenario".ljust(14), "estimate".rjust(9), "exact bytes".rjust(12), "ratio".rjust(7))
for name in SCENARIOS:
    spans = make_pool(name, 100)
    est = sum(estimate_size(s) for s in spans) / len(spans)
    exact = sum(len(json_dumps(to_transport_format(s))) for s in spans) / len(spans)
    print(name.ljust(14), ("%.0f" % est).rjust(9), ("%.0f" % exact).rjust(12), ("%.2f" % (est / exact)).rjust(7))
