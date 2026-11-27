// png-squeeze: lossless PNG re-encoder that writes each 1280x720 RGBA screenshot
// in as few bytes as possible.
//
// Approach (v2 — revised after the first practice run):
//   - decode the stored PNG to RGBA (own decoder, no dependencies);
//   - analyse the image and try every lossless form that can hold it exactly:
//     palette (colour type 3, <=256 colours, count and luminance order),
//     grey / grey+alpha, RGB / RGBA, and grey/RGB with a tRNS transparent key
//     when the image has a single fully-transparent value;
//   - for each form, try the filter choices (fixed 0/1/2/3/4, per-row minimum
//     signed-sum, fewest-distinct-pairs, per-row brute-force zlib trial),
//     screened by zlib level 6; when brute-force screens best, its row trials
//     are redone at level 6 and kept when they screen smaller;
//   - keep the two best-screened candidates and re-compress them at zlib
//     level 9 with several strategy/memLevel variants, keeping the smallest
//     total file (IDAT + PLTE/tRNS chunk overhead included);
//   - write one IDAT, chunks IHDR/PLTE/tRNS/IDAT/IEND only, bit depth 8.
// Deterministic: no randomness, no wall-clock influence on the output bytes
// (the time guard only ever drops work, never changes a kept result's bytes
// for a given input on a fast-enough run; see the budget guard below).
//
// Filter/form screening follows the contest kit's own scale compressor
// (program/generator/subject/scale.mjs, make.fun, MIT): same forms, same
// filter heuristics, same level-6 screen. The wins over the scale (and over
// the fixed-Paeth house baseline) come from the level-9 final compression
// with strategy/memLevel search and from screening every form+filter
// combination instead of stopping at the first good one.

import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG codec
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Decode any bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('bad PNG signature');
  let at = 8;
  let width = 0, height = 0, colourType = 6;
  let plte = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported bit depth / interlace');
      colourType = data[9];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else {
      throw new Error(`unsupported chunk ${type}`);
    }
    at += 12 + len;
  }
  const ch = CHANNELS[colourType];
  if (ch === undefined) throw new Error(`unsupported colour type ${colourType}`);
  const total = idat.reduce((s, d) => s + d.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const d of idat) { z.set(d, off); off += d.length; }
  const raw = inflateSync(z);
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected IDAT length');
  // Unfilter into samples.
  const samples = new Uint8Array(height * stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = samples.subarray(y * stride, (y + 1) * stride);
    const bpp = colourType === 3 ? 1 : ch;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = y === 0 ? 0 : prev[i];
      const c = y === 0 || i < bpp ? 0 : prev[i - bpp];
      let v = row[i];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) v = (v + paeth(a, b, c)) & 0xff;
      else if (f !== 0) throw new Error(`bad filter ${f}`);
      out[i] = v;
    }
    prev.set(out);
  }
  // Expand samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    for (let i = 0, s = 0, d = 0; i < width * height; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2]; rgba[d + 3] = 255;
    }
  } else if (colourType === 0) {
    for (let i = 0, d = 0; i < width * height; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g;
      rgba[d + 3] = trns && g === ((trns[0] << 8) | trns[1]) ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < width * height; i++, s += 2, d += 4) {
      const g = samples[s];
      rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g; rgba[d + 3] = samples[s + 1];
    }
  } else if (colourType === 3) {
    if (!plte) throw new Error('palette image without PLTE');
    for (let i = 0, d = 0; i < width * height; i++, d += 4) {
      const idx = samples[i] * 3;
      rgba[d] = plte[idx]; rgba[d + 1] = plte[idx + 1]; rgba[d + 2] = plte[idx + 2];
      rgba[d + 3] = trns && samples[i] < trns.length ? trns[samples[i]] : 255;
    }
  }
  return { rgba, width, height };
}

// ---------------------------------------------------------------- analysis
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- filtering
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Filter `samples` by `choice`: a fixed type, 'minsum', 'pairs' or 'brute'.
// `bruteLevel` is the zlib level the per-row brute-force trials are weighed
// at (4 for screening; 6 for the refinement pass, which weighs rows closer
// to how the final level-9 stream sees them).
function filtered(samples, width, height, bpp, choice, raw, bruteLevel) {
  if (bruteLevel === undefined) bruteLevel = BRUTE_LEVEL;
  const stride = width * bpp;
  if (!raw) raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: bruteLevel, memLevel: 9 } : { level: bruteLevel, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const FILTERS = {
  palette: [0],
  paletteByLuminance: [0, 'minsum', 'brute'],
  // Fixed Average (3) is not in the kit's channel screen; it wins on some
  // smooth gradient rows, so it is screened too (one extra cheap deflate).
  channels: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
};

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', FILTERS.palette], ['luminance', FILTERS.paletteByLuminance]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------- squeeze
// Wall-clock guard: the set budget is 60 s. If we are running late, later
// images skip the expensive per-row brute-force screen and use fewer
// level-9 variants. (On the practice set the full pipeline takes ~19 s.)
const START = Date.now();
const BUDGET_MS = 50000;

function squeeze(rgba, width, height) {
  const late = () => Date.now() - START > BUDGET_MS;
  const forms = formsOf(rgba);
  const top = []; // up to 3 best-screened { form, choice, data, bytes6 }
  const consider = (form, choice, data, bytes6) => {
    if (top.length < 3 || bytes6 < top[top.length - 1].bytes6) {
      top.push({ form, choice, data, bytes6 });
      top.sort((a, b) => a.bytes6 - b.bytes6);
      if (top.length > 3) top.pop();
    }
  };
  for (const form of forms) {
    for (const choice of form.filters) {
      if (choice === 'brute' && late()) continue;
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const bytes6 = deflateSync(data, SCREEN).length + chunkBytes(form);
      consider(form, choice, data, bytes6);
    }
  }
  // Refinement: when the per-row brute-force choice screened best, redo its
  // row trials at level 6 (closer to the final level-9 stream) and keep the
  // refinement when it screens smaller. Measured on the practice set: a few
  // dozen bytes on the images where brute wins, never worse (screened).
  if (top.length > 0 && top[0].choice === 'brute' && !late()) {
    const c = top[0];
    const data = filtered(c.form.samples, width, height, c.form.bpp, 'brute', undefined, 6);
    const bytes6 = deflateSync(data, SCREEN).length + chunkBytes(c.form);
    if (bytes6 < c.bytes6) consider(c.form, 'brute', data, bytes6);
  }
  // Final compression: level 9, strategy/memLevel search on the finalists.
  // Three finalists, not two: the level-6 screen sometimes misranks against
  // level 9, and the brute refinement must not evict a finalist (pairs on
  // i003) that wins at level 9.
  const variants = late()
    ? [[0, 8]]
    : [[0, 8], [1, 8], [0, 9], [1, 9]];
  let best = null;
  for (const c of top) {
    for (const [strat, ml] of variants) {
      const z = deflateSync(c.data, { level: 9, memLevel: ml, strategy: strat });
      const total = z.length + chunkBytes(c.form);
      if (best === null || total < best.total) {
        best = { total, form: c.form, zlib: new Uint8Array(z.buffer, z.byteOffset, z.length) };
      }
    }
  }
  return pngOfForm(width, height, best.form, best.zlib);
}

// ---------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const out = squeeze(image.rgba, image.width, image.height);
  if (out.length > 4194304) throw new Error(`${id}: output ${out.length} bytes exceeds 4 MiB`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out);
}
