#!/usr/bin/env python3
"""
inspect-tiles.py — Kenney 1-bit colored_packed.png tile inspector

Usage:
  python3 scripts/inspect-tiles.py                  # show all non-empty frames
  python3 scripts/inspect-tiles.py --green           # frames with most green pixels
  python3 scripts/inspect-tiles.py --gray            # frames with most gray pixels
  python3 scripts/inspect-tiles.py --frame 54        # inspect one specific frame
  python3 scripts/inspect-tiles.py --frame 0 54 72   # compare multiple frames

colored_packed.png palette (4-bit indexed, 8 colors):
  0 = YELLOW    (244,180,27)
  1 = GREEN     (56,217,115)
  2 = BROWNDARK (122,68,74)    ← ground/path color
  3 = BLUE      (60,172,215)
  4 = RED       (230,72,46)
  5 = TAN       (191,121,88)
  6 = GRAY      (207,198,184)
  7 = BG        (71,45,60)     ← transparent background (ignore these pixels)

Frame index = row * 49 + col  (0-based, no spacing)
"""
import struct, zlib, sys, argparse

TILESHEET = "public/assets/kenney-1-bit/Tilesheet/colored_packed.png"
COLS, ROWS = 49, 22
BG_IDX = 7

COLOR_NAMES = {0:'YELLOW', 1:'GREEN', 2:'BROWNDARK', 3:'BLUE',
               4:'RED', 5:'TAN', 6:'GRAY', 7:'BG'}
PALETTE_RGB = [
    (244,180,27), (56,217,115), (122,68,74), (60,172,215),
    (230,72,46),  (191,121,88), (207,198,184),(71,45,60),
]

def load_png(path):
    with open(path, 'rb') as f: data = f.read()
    chunks = {}
    i = 8
    while i < len(data):
        l = struct.unpack('>I', data[i:i+4])[0]
        ct = data[i+4:i+8].decode('ascii')
        if ct not in chunks: chunks[ct] = []
        chunks[ct].append(data[i+8:i+8+l])
        i += 12 + l
    W, H = struct.unpack('>II', chunks['IHDR'][0][:8])
    raw = zlib.decompress(b''.join(chunks['IDAT']))
    rb = (W * 4 + 7) // 8
    pixels = []
    prev = [0]*rb
    idx = 0
    for y in range(H):
        ft = raw[idx]; idx += 1
        row = list(raw[idx:idx+rb]); idx += rb
        if ft == 1:
            for x in range(1, rb): row[x] = (row[x]+row[x-1])%256
        elif ft == 2:
            for x in range(rb): row[x] = (row[x]+prev[x])%256
        px = []
        for b in row:
            px.append((b>>4)&0xF); px.append(b&0xF)
        pixels.append(px[:W])
        prev = row
    return pixels, W, H

def analyze(pixels, W, H, frame):
    tw, th = W//COLS, H//ROWS
    c, r = frame % COLS, frame // COLS
    x0, y0 = c*tw, r*th
    counts = {}
    for y in range(y0, y0+th):
        for x in range(x0, x0+tw):
            pi = pixels[y][x]
            if pi != BG_IDX:
                counts[pi] = counts.get(pi, 0) + 1
    return counts

def fmt(frame, counts):
    if not counts:
        return f"Frame {frame:4d} (r{frame//COLS:2d}c{frame%COLS:2d}): EMPTY"
    parts = ', '.join(f"{COLOR_NAMES[k]}={v}" for k,v in sorted(counts.items(), key=lambda x:-x[1]))
    total = sum(counts.values())
    dominant = max(counts, key=counts.get)
    rgb = PALETTE_RGB[dominant]
    return f"Frame {frame:4d} (r{frame//COLS:2d}c{frame%COLS:2d}): {total:3d}px | {parts}  → #{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--green',  action='store_true', help='Top frames by green pixel count')
    p.add_argument('--gray',   action='store_true', help='Top frames by gray pixel count')
    p.add_argument('--yellow', action='store_true', help='Top frames by yellow pixel count')
    p.add_argument('--tan',    action='store_true', help='Top frames by tan pixel count')
    p.add_argument('--brown',  action='store_true', help='Top frames by browndark pixel count')
    p.add_argument('--frame',  nargs='+', type=int,  help='Inspect specific frame number(s)')
    p.add_argument('--top',    type=int, default=20, help='How many results to show (default 20)')
    args = p.parse_args()

    pixels, W, H = load_png(TILESHEET)
    all_counts = [analyze(pixels, W, H, f) for f in range(COLS*ROWS)]

    if args.frame:
        for f in args.frame:
            print(fmt(f, all_counts[f]))
        return

    color_idx = None
    label = "sprite"
    if args.green:   color_idx, label = 1, "GREEN"
    elif args.gray:  color_idx, label = 6, "GRAY"
    elif args.yellow:color_idx, label = 0, "YELLOW"
    elif args.tan:   color_idx, label = 5, "TAN"
    elif args.brown: color_idx, label = 2, "BROWNDARK"

    if color_idx is not None:
        ranked = sorted([(cc.get(color_idx,0), i) for i, cc in enumerate(all_counts)], reverse=True)
        print(f"Top {args.top} frames by {label} pixel count:")
        for n, f in ranked[:args.top]:
            if n > 0: print(f"  {fmt(f, all_counts[f])}")
    else:
        print(f"All non-empty frames in colored_packed.png ({COLS}×{ROWS}, {COLS*ROWS} total):")
        for f, cc in enumerate(all_counts):
            if cc: print(f"  {fmt(f, cc)}")

if __name__ == '__main__':
    main()
