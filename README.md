# PNG Squeeze — lossless screenshot re-encoder

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/zonzonbk88/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/zonzonbk88/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)


A dependency-free Node 22 program (`main.ts`, plain JavaScript in a `.ts`
file) that re-encodes each 1280×720 RGBA screenshot as the smallest valid
lossless PNG it can, in one run over a whole set of 8.

## How it works

1. **Decode** the stored input PNG to RGBA with an own decoder
   (bit depth 8, colour types 0/2/3/4/6, unfiltering all five filters).
2. **Analyse** each image: opaque? grey? at most 256 distinct colours?
   a single fully-transparent value usable as a tRNS key?
3. **Try every lossless form** that can hold the image exactly:
   - palette (type 3, ≤256 colours) in count order and luminance order,
     transparent entries first so tRNS stays short;
   - grey (0) / grey+alpha (4) when every pixel is grey;
   - RGB (2) / RGBA (6) otherwise, with a tRNS key instead of an alpha
     channel when the image has one transparent value and no other
     partial alpha.
4. **Try the filters** per form — fixed None/Sub/Up/Average/Paeth,
   per-row minimum signed-sum, fewest-distinct-byte-pairs, and per-row
   brute-force (each row's five filters weighed by a real zlib trial
   against the preceding 32 KiB) — screened by zlib level 6.
   When brute-force screens best, its row trials are redone at level 6
   and kept when they screen smaller.
5. **Final compression**: the three best-screened candidates are
   re-compressed at zlib level 9 with strategy/memLevel variants
   (default/filtered × memLevel 8/9); the smallest total file wins,
   counting PLTE/tRNS chunk overhead.
6. **Write** one IDAT holding a single zlib stream, chunks
   IHDR / PLTE / tRNS / IDAT / IEND only, bit depth 8, not interlaced.

A wall-clock guard (50 s of the 60 s set budget) drops the expensive
brute-force screen and trims the level-9 variants if the run is late;
on the practice set the full pipeline takes ~26 s for 8 images.
Output is deterministic: two runs write identical bytes.

## Practice-set results (kit's checker, pixel-exact on all 8)

| instance | theme | bytes | points | house baseline |
|----------|-------|-------|--------|----------------|
| i001 | flat  | 12,496  | 718.4 | 98.2  |
| i002 | rich  | 51,852  | 705.5 | 607.0 |
| i003 | alpha | 106,527 | 675.1 | 670.3 |
| i004 | grey  | 105,518 | 696.8 | 369.1 |
| i005 | flat  | 16,552  | 742.3 | 256.4 |
| i006 | rich  | 178,606 | 690.7 | 601.0 |
| i007 | alpha | 60,890  | 701.9 | 522.6 |
| i008 | grey  | 24,897  | 714.2 | 238.6 |
| **total** | | **557,338** | **5,644.9 / 8,000** | **3,363.2** |

Total output 557,338 bytes vs the fixed-Paeth baseline's 708,151
(~21% smaller); every output decodes pixel-exact, including fully
transparent pixels' colours.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/<id>/image.png`, writes
`$MAKEFUN_OUTPUT_DIR/<id>/image.png` (defaults `/input`, `/output`).
