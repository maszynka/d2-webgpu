// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal ZIP for save backups: writes stored (uncompressed) entries; reads stored and deflated ones (archives a user
// re-zipped with the OS tools), via DecompressionStream('deflate-raw'). No ZIP64, no encryption, no multi-disk.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** modification time (DOS precision, 2 s) */
  date?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): [number, number] {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return [time, date];
}

/** Build a ZIP archive of stored entries (names are UTF-8, flag bit 11). */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const [time, date] = dosTime(e.date ?? new Date());
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, e.data);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Inflate at most `limit` bytes; more output means the entry lies about its size (or is a bomb): throw. */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(limit);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > limit) {
      await reader.cancel();
      throw new Error('ZIP entry inflates beyond its declared size');
    }
    out.set(value, n);
    n += value.length;
  }
  return out.subarray(0, n);
}

export interface ReadZipOptions {
  /** entries to read; the others are skipped before inflating */
  accept?: (name: string) => boolean;
  /** largest uncompressed entry (bytes) */
  maxEntry?: number;
  /** largest total of the accepted entries (bytes) */
  maxTotal?: number;
}

/** Read the files of a ZIP archive (directories skipped). Throws on a malformed archive or an unsupported method. */
export async function readZip(buf: Uint8Array, opts: ReadZipOptions = {}): Promise<ZipEntry[]> {
  const maxEntry = opts.maxEntry ?? 64 << 20;
  const maxTotal = opts.maxTotal ?? 256 << 20;
  let total = 0;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // end of central directory: the last signature within the 64 KiB comment window
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  const latin = new TextDecoder('latin1');
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x0800 ? utf8 : latin).decode(rawName);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || (opts.accept && !opts.accept(name))) continue;
    if (size > maxEntry) throw new Error(`${name}: ${size} bytes is more than this archive may hold per file`);
    total += size;
    if (total > maxTotal) throw new Error('ZIP archive is too large');
    if (flags & 1) throw new Error(`${name}: encrypted ZIP entries are not supported`);
    if (lho + 30 > buf.length || v.getUint32(lho, true) !== 0x04034b50) throw new Error(`${name}: corrupt ZIP entry`);
    const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    if (start + csize > buf.length) throw new Error(`${name}: truncated ZIP entry`);
    const raw = buf.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw, size);
    else throw new Error(`${name}: ZIP compression method ${method} is not supported`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: ZIP checksum mismatch`);
    out.push({ name, data });
  }
  return out;
}
