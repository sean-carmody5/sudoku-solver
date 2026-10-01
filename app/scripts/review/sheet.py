"""Contact sheet of a recorded run (record.mjs): frames in a time window laid
out in a grid, each labelled with its time and phase, so a motion can be
reviewed frame by frame.

Usage (model venv): python sheet.py <run-dir> [--from X] [--to Y] [--max 40]
                    [--cols 8] [--width 200] [--out sheet.png]
X/Y are ms on the page clock, or a mark label / phase name (its start) or
"N:phase" (the Nth phase, as record.mjs prints them), with
an optional +/-offset in ms, e.g. --from "tap scan-200" --to "overlay closed+1500".
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def resolve(run: dict, spec: str | None, default: float) -> float:
    if spec is None:
        return default
    try:
        return float(spec)
    except ValueError:
        pass
    base, off = spec, 0.0
    for sign in "+-":
        head, sep, tail = spec.rpartition(sign)
        if sep and head and tail.replace(".", "").isdigit():
            base, off = head, float(tail) * (1 if sign == "+" else -1)
            break
    for m in run["marks"]:
        if m["label"] == base:
            return m["t"] + off
    head, sep, _ = base.partition(":")
    if sep and head.isdigit() and int(head) < len(run["phases"]):
        return run["phases"][int(head)]["t"] + off
    for p in run["phases"]:
        if p["phase"] == base or p["phase"].startswith(base):
            return p["t"] + off
    raise SystemExit(f"no mark or phase called {base!r}")


def phase_at(run: dict, t: float) -> str:
    cur = ""
    for p in run["phases"]:
        if p["t"] <= t:
            cur = p["phase"]
    return cur


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--width", type=int, default=200)
    ap.add_argument("--out")
    args = ap.parse_args()

    run_dir = Path(args.run)
    run = json.loads((run_dir / "run.json").read_text())
    frames = run["frames"]
    t0 = resolve(run, args.start, frames[0]["t"])
    t1 = resolve(run, args.end, frames[-1]["t"])
    sel = [f for f in frames if t0 <= f["t"] <= t1]
    if not sel:
        raise SystemExit("no frames in that window")
    if len(sel) > args.max:
        step = len(sel) / args.max
        sel = [sel[int(i * step)] for i in range(args.max)]

    first = Image.open(run_dir / "frames" / sel[0]["file"])
    w = args.width
    h = round(first.height * w / first.width)
    label_h = 30
    cols = min(args.cols, len(sel))
    rows = (len(sel) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (w + 6) + 6, rows * (h + label_h + 6) + 6), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    prev = None
    for i, f in enumerate(sel):
        img = Image.open(run_dir / "frames" / f["file"]).convert("RGB").resize((w, h), Image.LANCZOS)
        x = 6 + (i % cols) * (w + 6)
        y = 6 + (i // cols) * (h + label_h + 6)
        sheet.paste(img, (x, y))
        gap = f"+{f['t'] - prev:.0f}" if prev is not None else ""
        prev = f["t"]
        draw.text((x + 2, y + h + 2), f"{f['t'] - t0:.0f} ms {gap}", fill=(230, 230, 230), font=font)
        draw.text((x + 2, y + h + 15), phase_at(run, f["t"])[:30], fill=(150, 200, 255), font=font)
    out = Path(args.out) if args.out else run_dir / "sheet.png"
    sheet.save(out)
    print(f"{len(sel)} frames, {t1 - t0:.0f} ms -> {out}")


if __name__ == "__main__":
    main()
