"""Motion and frame-timing plots of a recorded run (record.mjs).

Top: frame time (rAF delta) across the run, phases shaded, marks drawn,
long animation frames as red ticks. Below, per tracked element: centre x/y,
width and opacity against time, and the centre's speed - a smooth motion has
a speed curve without steps or spikes; a snap or a restart shows at once.

Usage (model venv): python plot.py <run-dir> [--from X] [--to Y]
                    [--keys morph,stage,grid] [--out plot.png]
(X/Y as in sheet.py.)
"""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from sheet import resolve  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--keys", default="")
    ap.add_argument("--out")
    args = ap.parse_args()

    run_dir = Path(args.run)
    run = json.loads((run_dir / "run.json").read_text())
    raf = np.array(run["raf"])
    t0 = resolve(run, args.start, raf[0])
    t1 = resolve(run, args.end, raf[-1])
    keys = [k for k in args.keys.split(",") if k] or [
        k for k, v in run["tracks"].items() if any(t0 <= r[0] <= t1 for r in v)
    ]

    fig, axes = plt.subplots(1 + len(keys), 1, figsize=(11, 2.4 * (1 + len(keys))), sharex=True, squeeze=False)
    axes = axes[:, 0]
    m = (raf >= t0) & (raf <= t1)
    ts = raf[m]
    d = np.diff(ts)
    ax = axes[0]
    ax.plot(ts[1:] - t0, d, ".", ms=3, color="#333")
    ax.axhline(16.7, color="#2a2", lw=0.8)
    ax.axhline(25, color="#d80", lw=0.8)
    ax.set_ylim(0, max(60, min(200, d.max() * 1.1 if len(d) else 60)))
    ax.set_ylabel("frame ms")
    colours = plt.cm.tab20(np.linspace(0, 1, 20))
    for i, p in enumerate(run["phases"]):
        end = run["phases"][i + 1]["t"] if i + 1 < len(run["phases"]) else raf[-1]
        if end < t0 or p["t"] > t1:
            continue
        for a in axes:
            a.axvspan(max(p["t"], t0) - t0, min(end, t1) - t0, color=colours[i % 20], alpha=0.12, lw=0)
        ax.text(max(p["t"], t0) - t0, ax.get_ylim()[1] * 0.92, p["phase"][:22], fontsize=7, rotation=0)
    for mk in run["marks"]:
        if t0 <= mk["t"] <= t1:
            for a in axes:
                a.axvline(mk["t"] - t0, color="#06c", lw=0.8, ls="--")
            ax.text(mk["t"] - t0, ax.get_ylim()[1] * 0.75, mk["label"], fontsize=7, color="#06c")
    for lf in run["loaf"]:
        if t0 <= lf["t"] <= t1:
            ax.plot([lf["t"] - t0, lf["t"] - t0 + lf["dur"]], [3, 3], color="red", lw=3)
    dropped = int((d > 25).sum())
    ax.set_title(f"{run['flow']}  cpu x{run['cpu']}  frames {len(d)}  dropped (>25 ms) {dropped}", fontsize=9)

    for ax, k in zip(axes[1:], keys):
        rows = np.array([r for r in run["tracks"].get(k, []) if t0 <= r[0] <= t1])
        ax.set_ylabel(k)
        if len(rows) < 2:
            continue
        t = rows[:, 0] - t0
        cx = rows[:, 1] + rows[:, 3] / 2
        cy = rows[:, 2] + rows[:, 4] / 2
        ax.plot(t, cx, label="cx", lw=1)
        ax.plot(t, cy, label="cy", lw=1)
        ax.plot(t, rows[:, 3], label="w", lw=1)
        ax.plot(t, rows[:, 4], label="h", lw=1, ls=":")
        dt = np.maximum(np.diff(rows[:, 0]), 1e-3)
        speed = np.hypot(np.diff(cx), np.diff(cy)) / dt * 1000
        grow = np.abs(np.diff(rows[:, 3])) / dt * 1000
        ax2 = ax.twinx()
        ax2.plot(t[1:], speed, color="#c33", lw=0.8, label="speed px/s")
        ax2.plot(t[1:], grow, color="#939", lw=0.8, ls="--", label="size px/s")
        ax2.plot(t, rows[:, 5] * max(1, speed.max() if len(speed) else 1), color="#999", lw=0.8, label="opacity (scaled)")
        ax2.tick_params(labelsize=7)
        ax.legend(fontsize=6, loc="upper left")
        ax2.legend(fontsize=6, loc="upper right")
    axes[-1].set_xlabel("ms")
    fig.tight_layout()
    out = Path(args.out) if args.out else run_dir / "plot.png"
    fig.savefig(out, dpi=90)
    print(f"-> {out}")


if __name__ == "__main__":
    main()
