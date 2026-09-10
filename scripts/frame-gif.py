#!/usr/bin/env python3
"""
Composite screen recordings into the blank screens of a device-mockup image.

Give it a mockup whose screens are blank (white), plus a GIF or MP4 per screen,
and it writes an animated GIF with each recording playing inside its device.

    python3 scripts/frame-gif.py mockup.png --laptop desk.mp4 --phone phone.mp4 \
        -o design/brand/havemind-hero.gif

Screens are found by scanning for large near-white rectangles, so any mockup
with blank screens works, not one hard-coded frame. `--inspect` draws what it
found and stops, which is the fast way to check a new mockup before rendering.

Requires: pillow, and ffmpeg on PATH for MP4 input.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageSequence
except ImportError:
    sys.exit("Needs pillow:  pip3 install pillow")

WHITE = 245          # a pixel this bright in every channel counts as screen
MIN_SIDE = 60        # ignore rectangles smaller than this, they are highlights
EDGE = 2             # a screen sits inside a bezel, never on the image edge


def find_screens(img):
    """Return blank screen boxes, largest first, as (left, top, right, bottom)."""
    px = img.convert("RGB").load()
    w, h = img.size

    runs_by_row = []
    for y in range(h):
        runs, start = [], None
        for x in range(w):
            r, g, b = px[x, y]
            if r > WHITE and g > WHITE and b > WHITE:
                if start is None:
                    start = x
            elif start is not None:
                if x - start >= MIN_SIDE:
                    runs.append((start, x))
                start = None
        if start is not None and w - start >= MIN_SIDE:
            runs.append((start, w))
        runs_by_row.append(runs)

    # Grow each run downward into a box while a row below still overlaps it.
    boxes, claimed = [], set()
    for y, runs in enumerate(runs_by_row):
        for x0, x1 in runs:
            if (y, x0, x1) in claimed:
                continue
            top, left, right, bottom = y, x0, x1, y
            yy = y
            while yy + 1 < h:
                # Require most of the width to continue. A device screen has
                # straight sides; the page background behind a phone does not,
                # and matching loosely is what let a screen bleed into it.
                nxt = [
                    (a, b)
                    for a, b in runs_by_row[yy + 1]
                    if min(b, right) - max(a, left) > (right - left) * 0.9
                ]
                if not nxt:
                    break
                a, b = max(nxt, key=lambda r: r[1] - r[0])
                claimed.add((yy + 1, a, b))
                left, right = max(left, a), min(right, b)
                bottom = yy = yy + 1
            if bottom - top < MIN_SIDE or right - left < MIN_SIDE:
                continue
            touches_edge = (
                left <= EDGE or top <= EDGE
                or right >= w - EDGE or bottom >= h - EDGE
            )
            if touches_edge:
                continue
            boxes.append((left, top, right, bottom))

    boxes.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)

    # Drop boxes swallowed by a larger one (screen glare, rounded corners).
    kept = []
    for box in boxes:
        l, t, r, b = box
        if any(L <= l and T <= t and R >= r and B >= b for L, T, R, B in kept):
            continue
        kept.append(box)
    return kept


def load_frames(path, tmp):
    """Frames of a GIF, or of an MP4 decoded through ffmpeg."""
    path = Path(path)
    if path.suffix.lower() in {".mp4", ".mov", ".webm", ".m4v"}:
        if not shutil.which("ffmpeg"):
            sys.exit(f"{path.name} needs ffmpeg on PATH")
        out = Path(tmp) / path.stem
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", str(path),
             "-vf", "fps=12", str(out / "%04d.png")],
            check=True,
        )
        files = sorted(out.glob("*.png"))
        if not files:
            sys.exit(f"ffmpeg produced no frames from {path.name}")
        return [Image.open(f).convert("RGB") for f in files]

    src = Image.open(path)
    return [f.convert("RGB").copy() for f in ImageSequence.Iterator(src)]


def fit(frame, size):
    """Scale to cover the screen, then centre-crop. No letterboxing, no squash."""
    tw, th = size
    fw, fh = frame.size
    scale = max(tw / fw, th / fh)
    resized = frame.resize((max(1, round(fw * scale)), max(1, round(fh * scale))),
                           Image.LANCZOS)
    rw, rh = resized.size
    left, top = (rw - tw) // 2, (rh - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mockup", help="mockup image with blank (white) screens")
    ap.add_argument("--laptop", help="GIF/MP4 for the largest screen")
    ap.add_argument("--phone", help="GIF/MP4 for the second largest screen")
    ap.add_argument("-o", "--out", default="hero.gif")
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--width", type=int, default=1200, help="output width")
    ap.add_argument("--colors", type=int, default=180, help="GIF palette size")
    ap.add_argument("--background", default="#12101c",
                    help="fills transparency; use 'none' to keep it")
    ap.add_argument("--bleed", type=int, default=3,
                    help="grow each screen by N px to cover anti-aliased edges")
    ap.add_argument("--inspect", action="store_true",
                    help="mark detected screens and exit")
    args = ap.parse_args()

    mock = Image.open(args.mockup)
    if mock.mode != "RGBA":
        mock = mock.convert("RGBA")

    screens = find_screens(mock)
    if not screens:
        sys.exit("No blank screens found. The screens must be near-white.")

    if args.bleed:
        w, h = mock.size
        screens = [
            (max(0, l - args.bleed), max(0, t - args.bleed),
             min(w, r + args.bleed), min(h, b + args.bleed))
            for l, t, r, b in screens
        ]

    if args.inspect:
        marked = mock.convert("RGB")
        draw = ImageDraw.Draw(marked)
        for i, (l, t, r, b) in enumerate(screens[:4]):
            draw.rectangle([l, t, r, b], outline=(255, 0, 0), width=4)
            draw.text((l + 8, t + 8), f"#{i+1} {r-l}x{b-t}", fill=(255, 0, 0))
        out = Path(args.out).with_suffix(".inspect.png")
        marked.save(out)
        for i, (l, t, r, b) in enumerate(screens[:4]):
            print(f"#{i+1}  {r-l}x{b-t} at ({l},{t})")
        print(f"wrote {out}")
        return

    targets = []
    if args.laptop:
        targets.append((screens[0], args.laptop))
    if args.phone:
        if len(screens) < 2:
            sys.exit("Only one screen found, so --phone has nowhere to go.")
        targets.append((screens[1], args.phone))
    if not targets:
        sys.exit("Give at least one of --laptop or --phone.")

    with tempfile.TemporaryDirectory() as tmp:
        clips = [(box, load_frames(src, tmp)) for box, src in targets]
        total = max(len(f) for _, f in clips)

        if args.background.lower() == "none":
            base = mock
        else:
            base = Image.new("RGBA", mock.size, args.background)
            base.alpha_composite(mock)

        out_frames = []
        for i in range(total):
            canvas = base.copy()
            for (l, t, r, b), frames in clips:
                # Short clips loop rather than freezing on the last frame.
                canvas.paste(fit(frames[i % len(frames)], (r - l, b - t)), (l, t))
            if args.width and args.width != canvas.width:
                ratio = args.width / canvas.width
                canvas = canvas.resize(
                    (args.width, round(canvas.height * ratio)), Image.LANCZOS)
            out_frames.append(canvas.convert("RGB"))

        pal = [f.quantize(colors=args.colors, method=Image.MEDIANCUT)
               for f in out_frames]
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        pal[0].save(out, save_all=True, append_images=pal[1:],
                    duration=round(1000 / args.fps), loop=0, optimize=True)

    mb = out.stat().st_size / 1_048_576
    print(f"{out}  {len(out_frames)} frames  {mb:.1f} MB")
    if mb > 5:
        print("Over 5 MB. Lower --width, --fps or --colors, or trim the clips.")


if __name__ == "__main__":
    main()
