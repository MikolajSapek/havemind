"""Composite the laptop and phone crops into Apple bezels, frame by frame.

Made the 1.7.1 hero. The recipe is in docs/screenshots.md; in short, one
screen recording with the Obsidian window and the iPhone Mirroring window side
by side, cropped into two frame folders with ffmpeg:

    ffmpeg -ss 2 -to 17.6 -i hero.mov -vf "crop=<laptop>,fps=12" WORK/lap/%04d.png
    ffmpeg -ss 2 -to 17.6 -i hero.mov -vf "crop=<phone below the status bar>,fps=12" WORK/ph/%04d.png
    python3 scripts/compose-hero.py WORK hero     # or: phone, for the phone-only cut

It writes WORK/comp/<mode>-NNNN.png; ffmpeg's palettegen turns those into the
GIF. Needs the Apple bezels in design/frames/apple/ (never committed).
"""
import sys, glob
from PIL import Image, ImageDraw, ImageOps
S, MODE = sys.argv[1], sys.argv[2]
BG = (18, 16, 28, 255)
mac = Image.open('design/frames/apple/macbook-pro-16.png').convert('RGBA')
iph = Image.open('design/frames/apple/iphone-17-pro.png').convert('RGBA')
MAC_HOLE, MAC_BOX = (817, 530, 4077, 2635), (455, 475, 4439, 2908)
IPH_HOLE, IPH_BOX = (152, 329, 1357, 2950), (94, 280, 1415, 2998)

def place(frame, hole, box, k, left, top):
    """Scale a bezel by k so its visible box starts at (left, top)."""
    f = frame.resize((round(frame.width * k), round(frame.height * k)), Image.LANCZOS)
    ox, oy = round(left - box[0] * k), round(top - box[1] * k)
    h = tuple(round(v * k) for v in hole)
    return f, (ox, oy), (ox + h[0], oy + h[1], ox + h[2], oy + h[3])

def cover(img, w, h):
    k = max(w / img.width, h / img.height)
    r = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    x, y = (r.width - w) // 2, (r.height - h) // 2
    return r.crop((x, y, x + w, y + h))

def phone_screen(img, w, h):
    """Status bar already cropped off: fit the width, sit at the bottom, black above."""
    img = img.copy()
    # iPhone Mirroring rounds its window more than the bezel rounds the
    # screen, so the bottom corners carry desktop wallpaper: black them out.
    mask = Image.new('L', img.size, 0)
    rad = round(img.width * 0.19)
    ImageDraw.Draw(mask).rounded_rectangle((0, -rad, img.width - 1, img.height - 1), rad, fill=255)
    img.paste((0, 0, 0), (0, 0), ImageOps.invert(mask))
    r = img.resize((w, round(img.height * w / img.width)), Image.LANCZOS)
    out = Image.new('RGB', (w, h), (0, 0, 0))
    out.paste(r.crop((0, max(0, r.height - h), w, r.height)), (0, max(0, h - r.height)))
    return out

if MODE == 'hero':
    W, H = 2800, 1806
    lw, ph_h, gap = 1900, 1000, 90
    km, kp = lw / (MAC_BOX[2] - MAC_BOX[0]), ph_h / (IPH_BOX[3] - IPH_BOX[1])
    pw = (IPH_BOX[2] - IPH_BOX[0]) * kp
    left = (W - (lw + gap + pw)) / 2
    ltop = (H - (MAC_BOX[3] - MAC_BOX[1]) * km) / 2
    macf, mpos, mh = place(mac, MAC_HOLE, MAC_BOX, km, left, ltop)
    centre = (mh[1] + mh[3]) / 2
    iphf, ipos, ih = place(iph, IPH_HOLE, IPH_BOX, kp, left + lw + gap, centre - ph_h / 2)
else:
    W, H = 932, 1904
    ph_h = 1560
    kp = ph_h / (IPH_BOX[3] - IPH_BOX[1])
    pw = (IPH_BOX[2] - IPH_BOX[0]) * kp
    iphf, ipos, ih = place(iph, IPH_HOLE, IPH_BOX, kp, (W - pw) / 2, (H - ph_h) / 2)
laps, phs = sorted(glob.glob(f'{S}/lap/*.png')), sorted(glob.glob(f'{S}/ph/*.png'))
for i, ph in enumerate(phs):
    c = Image.new('RGBA', (W, H), BG)
    if MODE == 'hero':
        c.paste(cover(Image.open(laps[i]).convert('RGB'), mh[2] - mh[0], mh[3] - mh[1]), mh[:2])
        c.paste(macf, mpos, macf)
    screen = phone_screen(Image.open(ph).convert('RGB'), ih[2] - ih[0], ih[3] - ih[1])
    # The hole's corners are round (radius 191 at full size); a square paste
    # pokes out past the bezel's outer curve.
    hole_mask = Image.new('L', screen.size, 0)
    ImageDraw.Draw(hole_mask).rounded_rectangle((0, 0, screen.width - 1, screen.height - 1), round(191 * kp), fill=255)
    c.paste(screen, ih[:2], hole_mask)
    c.paste(iphf, ipos, iphf)
    c.convert('RGB').save(f'{S}/comp/{MODE}-{i:04d}.png')
print(MODE, len(phs), 'frames')
