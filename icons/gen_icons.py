import zlib, struct

def png(path, size, bg, card, line):
    w = h = size
    px = bytearray()
    m = size // 8           # margin
    cx0, cy0, cx1, cy1 = m, m, size - m, size - m
    for y in range(h):
        px.append(0)        # filter byte per scanline
        for x in range(w):
            r, g, b = bg
            if cx0 <= x < cx1 and cy0 <= y < cy1:
                r, g, b = card
                # draw "note" lines inside the card
                rel = y - cy0
                inner = card[0] is not None
                step = (cy1 - cy0) // 6
                if step and (rel % step) < max(2, size // 64) and rel > step // 2 \
                   and (cx0 + (cx1 - cx0)//8) <= x < (cx1 - (cx1 - cx0)//8):
                    r, g, b = line
            px += bytes((r, g, b))

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(px), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))

BG = (11, 110, 79)      # theme green
CARD = (245, 247, 245)  # near white
LINE = (180, 196, 188)  # light gray-green
for s in (192, 512):
    png(f"/home/user/PWA-MVP/icons/icon-{s}.png", s, BG, CARD, LINE)
# maskable: same art but with more padding handled by safe zone; reuse 512
png("/home/user/PWA-MVP/icons/maskable-512.png", 512, BG, CARD, LINE)
print("icons generated")
