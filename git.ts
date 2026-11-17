// git.ts — git object model, pkt-line codec, pack read/write, delta application.
// Node 22 stdlib only. Everything here is deterministic: object ids are SHA-1 of
// "<type> <size>\0" + payload, exactly as git computes them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  // Stream the header and payload into the hash: no Buffer.concat copy of the payload.
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** One in-memory object store, shared by every repo (objects are content-addressed). */
export class ObjectStore {
  private readonly map = new Map<string, GitObject>();
  /**
   * Bumped on every object put: git objects are immutable, so a fetch-pack answer
   * built from a given object set stays valid until this counter moves.
   */
  version = 0;

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.map.get(oid);
  }

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) {
      this.map.set(oid, { type, data });
      this.version += 1;
    }
    return oid;
  }

  putRaw(oid: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(oid)) {
      this.map.set(oid, { type, data });
      this.version += 1;
    }
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Decode a pkt-line stream into lines. Returns {lines, rest} where `rest` is the bytes after
 *  the first flush (or the trailing bytes when no flush is present). A line whose first four
 *  bytes are not a valid hex length stops decoding and is returned as `garbage`. */
export function decodePktLines(buf: Buffer): { lines: string[]; rest: Buffer; garbage: boolean } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') return { lines, rest: buf.subarray(off + 4), garbage: false };
    if (head === '0001') {
      lines.push('\u0001');
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) return { lines, rest: buf.subarray(off), garbage: true };
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, rest: buf.subarray(off), garbage: off < buf.length };
}

// ---------------------------------------------------------------- pack files

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Deflate level for pack objects: 1 is the fastest level that still compresses
 *  (level 0 stores uncompressed and is slower and larger here; level 6 costs ~15%
 *  more CPU for ~1% smaller output on 1 KiB objects). The pack format is unchanged. */
const PACK_DEFLATE_LEVEL = 1;

export function writePack(entries: { oid: string; type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  // The trailer is the SHA-1 of every preceding byte: feed the hash incrementally
  // instead of Buffer.concat-ing the whole pack twice (once to hash, once to return).
  const trailerHash = createHash('sha1');
  const push = (buf: Buffer): void => {
    parts.push(buf);
    trailerHash.update(buf);
  };
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  push(header);
  for (const entry of entries) {
    // object header: type + size, varint (little-endian 7-bit groups).
    let size = entry.data.length;
    const typeId = PACK_TYPE_IDS[entry.type];
    let byte = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    while (size > 0) {
      headBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(byte);
    const deflated = deflateSync(entry.data, { level: PACK_DEFLATE_LEVEL });
    push(Buffer.from(headBytes));
    push(deflated);
  }
  parts.push(trailerHash.digest());
  return Buffer.concat(parts);
}

export function readPack(pack: Buffer): { oid: string; type: ObjType; data: Buffer }[] {
  if (pack.length < 12) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let off = 12;
  const entries: { oid: string; type: ObjType; data: Buffer }[] = [];
  const byOffset = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  const byOid = new Map<string, { oid: string; type: ObjType; data: Buffer }>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = pack[off];
    off += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off];
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeId === 6) {
      // OFS_DELTA: varint offset back from this object's start.
      let b = pack[off];
      off += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[off];
        off += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = start - offset;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      const inflated = inflateAt(pack, off);
      off = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else if (typeId === 7) {
      // REF_DELTA: 20-byte base oid.
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const base = byOid.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const inflated = inflateAt(pack, off);
      off = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
    } else {
      type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = inflateAt(pack, off);
      off = inflated.next;
      data = inflated.data;
    }
    if (data.length !== size) throw new Error('object size mismatch in pack');
    const oid = hashObject(type, data);
    const entry = { oid, type, data };
    entries.push(entry);
    byOffset.set(start, entry);
    byOid.set(oid, entry);
  }
  return entries;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta stream to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = delta[off];
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------------------------------------------------------------- commits/trees

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const commit: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  // git sorts tree entries by name, treating directories as if the name had a trailing '/'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const tag: ParsedTag = { object: '', type: 'commit', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

/** All objects reachable from `roots` (commit/tree/tag/blob), following parents, trees and tags. */
export function collectReachable(store: ObjectStore, roots: string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      queue.push(parsed.tree, ...parsed.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Commits reachable from `root` within `depth` generations (depth 1 = root only),
 *  plus the trees/blobs of those commits. Returns the object set and the shallow boundary:
 *  included commits at the deepest generation that still have parents outside the set. */
export function collectDepthLimited(
  store: ObjectStore,
  roots: string[],
  depth: number,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  // BFS over commits by generation.
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const root of roots) {
    const obj = store.get(root);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      objects.set(root, obj);
      queue.push({ oid: target, gen: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: root, gen: 0 });
    } else {
      // A bare tree/blob want: include it directly.
      const reached = collectReachable(store, [root]);
      for (const [oid, o] of reached) objects.set(oid, o);
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (commitGen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    commitGen.set(oid, gen);
    objects.set(oid, obj);
    const parsed = parseCommit(obj.data);
    // The commit's tree and blobs are always included.
    const treeReach = collectReachable(store, [parsed.tree]);
    for (const [tOid, tObj] of treeReach) objects.set(tOid, tObj);
    if (gen + 1 < depth) {
      for (const parent of parsed.parents) queue.push({ oid: parent, gen: gen + 1 });
    } else if (parsed.parents.length > 0) {
      shallow.push(oid);
    }
  }
  return { objects, shallow, unshallow: [] };
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const queue = [descendant];
  const seen = new Set<string>();
  let steps = 0;
  while (queue.length > 0 && steps < 200_000) {
    const oid = queue.pop() as string;
    steps += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** All ancestors of `tip` (including the tip itself), newest first by BFS order. */
export function walkCommits(store: ObjectStore, tip: string, limit = 100_000): string[] {
  const out: string[] = [];
  const queue = [tip];
  const seen = new Set<string>();
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

/** Merge-base: the first common ancestor of `a` and `b` found by BFS from both sides. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set(walkCommits(store, a));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Sideband pkt-lines: wrap `payload` into band-1 packets of at most 32768 bytes each,
 *  followed by a flush. `payload` is already a pkt-line stream. */
export function sidebandWrap(payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < payload.length; off += CHUNK) {
    const chunk = payload.subarray(off, Math.min(payload.length, off + CHUNK));
    const len = chunk.length + 5;
    const head = Buffer.alloc(4);
    head.write(len.toString(16).padStart(4, '0'), 'ascii');
    parts.push(head, Buffer.from([1]), chunk);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
