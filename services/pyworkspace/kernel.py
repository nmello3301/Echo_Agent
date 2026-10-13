"""Echo's persistent Python workspace: one namespace per agent run.

Reads one JSON request per line on stdin: {"code": "..."}; writes one JSON reply per line on stdout:
{"stdout", "stderr", "result", "error", "figures": [png paths]}. Variables persist between calls.
numpy (np), scipy, sympy (sp), pint (ureg, Q_) and matplotlib (plt) are imported up front.
Figures left open after a call are saved as PNGs in <plots dir> and closed.
"""
import ast
import contextlib
import io
import json
import os
import sys
import traceback

PLOTS = sys.argv[1] if len(sys.argv) > 1 else ".echo/plots"

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pint  # noqa: E402
import scipy  # noqa: E402
import sympy as sp  # noqa: E402

ureg = pint.UnitRegistry()
Q_ = ureg.Quantity
ns = {"np": np, "scipy": scipy, "sp": sp, "sympy": sp, "plt": plt, "ureg": ureg, "Q_": Q_, "__name__": "__echo__"}
fig_count = 0
out = sys.stdout  # the protocol channel; user prints are captured separately


def run(code: str) -> dict:
    global fig_count
    stdout, stderr = io.StringIO(), io.StringIO()
    result, error = None, None
    try:
        tree = ast.parse(code, mode="exec")
        last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        if last is not None:
            tree.body = tree.body[:-1]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(tree, "<echo>", "exec"), ns)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), "<echo>", "eval"), ns)
                if value is not None:
                    ns["_"] = value
                    result = repr(value)
    except BaseException:  # noqa: BLE001 - report everything, including SystemExit
        error = traceback.format_exc(limit=-3)
    figures = []
    for num in plt.get_fignums():
        os.makedirs(PLOTS, exist_ok=True)
        fig_count += 1
        path = os.path.join(PLOTS, f"plot-{fig_count}.png")
        plt.figure(num).savefig(path, dpi=110, bbox_inches="tight")
        figures.append(os.path.abspath(path))
    plt.close("all")
    return {"stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "result": result, "error": error, "figures": figures}


for line in sys.stdin:
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        continue
    reply = run(req.get("code", ""))
    out.write(json.dumps(reply) + "\n")
    out.flush()
