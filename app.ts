// app.ts — the HTTP server: routing, auth, and the git smart-HTTP endpoints.
// REST lives in rest.ts, GraphQL in graphql.ts, MCP in mcp.ts; this file owns the wire:
// JSON bodies, the token check, and the upload-pack / receive-pack protocol.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, requestId } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  collectDepthLimited,
  collectReachable,
  decodePktLines,
  isAncestor,
  parseTag,
  pktLine,
  readPack,
  sidebandWrap,
  writePack,
} from './git.ts';
import { DEFAULT_BRANCH } from './scenario.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  // Dev mode (no token configured): accept anything. In a trial the token is always set.
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${SHOP_TOKEN}`) return true;
  // GitHub-style Basic auth: the token as the password (what a real `git` client sends
  // when credentials are embedded in the remote URL).
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const password = colon === -1 ? decoded : decoded.slice(colon + 1);
      const user = colon === -1 ? '' : decoded.slice(0, colon);
      if (password === SHOP_TOKEN || user === SHOP_TOKEN) return true;
    } catch {
      // Not valid base64: fall through to false.
    }
  }
  return false;
}

// ---------------------------------------------------------------- git protocol

interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
}

function repoRefsForAdvertisement(repoOwner: string, repoName: string): RefLine[] | null {
  const repo = store.getRepo(repoOwner, repoName);
  if (!repo) return null;
  const lines: RefLine[] = [];
  for (const [ref, oid] of store.listRefs(repo)) {
    const line: RefLine = { oid, name: ref };
    if (ref.startsWith('refs/tags/')) {
      const obj = store.objects.get(oid);
      if (obj && obj.type === 'tag') line.peeled = parseTag(obj.data).object;
    }
    lines.push(line);
  }
  return lines;
}

function v0Advertisement(service: 'upload-pack' | 'receive-pack', repoOwner: string, repoName: string): Buffer | null {
  const refs = repoRefsForAdvertisement(repoOwner, repoName);
  if (refs === null) return null;
  const caps =
    service === 'upload-pack'
      ? 'symref=HEAD:refs/heads/main multi_ack side-band-64k thin-pack ofs-delta shallow agent=forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const defaultTip = refs.find((r) => r.name === `refs/heads/${DEFAULT_BRANCH}`);
    const headOid = defaultTip ? defaultTip.oid : refs[0].oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  deepen: number | null;
  deepenSince: number | null;
  thinPack: boolean;
  /** The client sent "done": negotiation is over, no acknowledgments section is sent. */
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowIn: [], deepen: null, deepenSince: null, thinPack: false, done: false };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === '\u0001' || text === '') continue;
    if (text.startsWith('command=')) continue;
    if (text.startsWith('agent=')) continue;
    if (text.startsWith('object-format=')) continue;
    if (text === 'thin-pack') req.thinPack = true;
    else if (text === 'no-progress' || text === 'ofs-delta') continue;
    else if (text.startsWith('want ')) req.wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) req.haves.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) req.shallowIn.push(text.slice(8, 48));
    else if (text.startsWith('deepen ')) req.deepen = Number.parseInt(text.slice(7), 10);
    else if (text.startsWith('deepen-since ')) req.deepenSince = Number.parseInt(text.slice(13), 10);
    else if (text.startsWith('deepen-not ')) continue;
    else if (text.startsWith('filter ')) continue;
    else if (text === 'done') req.done = true;
  }
  return req;
}

function buildFetchPack(req: FetchRequest): { objects: Map<string, { oid: string; type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  if (req.deepen !== null && req.deepen > 0) {
    const { objects, shallow } = collectDepthLimited(store.objects, req.wants, req.deepen);
    // An input shallow boundary is "unshallow" once it is included and no longer a boundary.
    const unshallow = req.shallowIn.filter((oid) => objects.has(oid) && !shallow.includes(oid));
    return { objects, shallow, unshallow };
  }
  const wanted = collectReachable(store.objects, req.wants);
  const held = collectReachable(store.objects, req.haves);
  for (const oid of held.keys()) wanted.delete(oid);
  return { objects: wanted, shallow: [], unshallow: [] };
}

function ackFor(req: FetchRequest): string | null {
  for (const have of req.haves) {
    if (!store.objects.get(have)) continue;
    for (const want of req.wants) {
      if (isAncestor(store.objects, have, want)) return have;
    }
  }
  return null;
}

function handleUploadPack(repoOwner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } | null {
  const repo = store.getRepo(repoOwner, repoName);
  if (!repo) return null;
  const decoded = decodePktLines(body);
  const lines = decoded.lines;
  const isV2 = lines.length > 0 && lines[0].startsWith('command=');
  if (isV2 && lines[0].startsWith('command=ls-refs')) {
    const args = lines.slice(1);
    const peel = args.some((l) => l.trim() === 'peel');
    const symrefs = args.some((l) => l.trim() === 'symrefs');
    const unborn = args.some((l) => l.trim() === 'unborn');
    const prefixes = args.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
    const refs = store.listRefs(repo);
    const out: Buffer[] = [];
    const defaultTip = store.getRef(repo, store.refName(DEFAULT_BRANCH));
    const matchesPrefix = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (refs.length === 0) {
      if (unborn) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    } else {
      if (symrefs && defaultTip && matchesPrefix('HEAD')) {
        out.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
      }
      for (const [ref, oid] of refs) {
        if (!matchesPrefix(ref)) continue;
        let line = `${oid} ${ref}`;
        const obj = store.objects.get(oid);
        if (peel && obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
        out.push(pktLine(`${line}\n`));
      }
    }
    out.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
  }
  if (isV2 && lines[0].startsWith('command=fetch')) {
    const req = parseFetchArgs(lines);
    const { objects, shallow, unshallow } = buildFetchPack(req);
    const ack = ackFor(req);
    const parts: Buffer[] = [];
    // Protocol v2 (git fetch-pack.c): when the client sent "done", the server MUST NOT
    // send an "acknowledgments" section — the response goes straight to shallow-info /
    // packfile. The acknowledgments section exists only for open negotiation rounds
    // (no "done"): "ready" (with a DELIM) means a packfile follows, a bare NAK with a
    // FLUSH means the client sends another round.
    if (!req.done) {
      parts.push(pktLine('acknowledgments\n'));
      if (ack) {
        parts.push(pktLine(`ACK ${ack}\n`), pktLine('ready\n'), PKT_DELIM);
      } else {
        parts.push(pktLine('NAK\n'), PKT_FLUSH);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
      }
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    const entries = [...objects.values()].sort((a, b) => (a.oid < b.oid ? -1 : 1));
    const pack = writePack(entries);
    parts.push(pktLine('packfile\n'), sidebandWrap(pack));
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  // v0 fetch: wants/haves/deepen as bare pkt-lines, possibly split by a flush.
  const req = parseFetchArgs(lines);
  if (req.wants.length === 0) return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no want lines' })) };
  const { objects, shallow, unshallow } = buildFetchPack(req);
  const ack = ackFor(req);
  const parts: Buffer[] = [];
  if (ack) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const entries = [...objects.values()].sort((a, b) => (a.oid < b.oid ? -1 : 1));
  parts.push(sidebandWrap(writePack(entries)));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleReceivePack(repoOwner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } | null {
  const repo = store.getRepo(repoOwner, repoName);
  if (!repo) return null;
  const decoded = decodePktLines(body);
  if (decoded.garbage) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  interface Command {
    old: string;
    next: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of decoded.lines) {
    const text = line.replace(/\n$/, '');
    if (text === '\u0001' || text === '') continue;
    const withoutCaps = text.split('\0')[0];
    const parts = withoutCaps.split(' ');
    if (parts.length < 3) continue;
    commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  }
  const report = (unpackOk: boolean, unpackError: string | null, results: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const lines: Buffer[] = [];
    if (unpackOk) lines.push(pktLine('unpack ok\n'));
    else lines.push(pktLine(`unpack ${unpackError ?? 'error'}\n`));
    for (const r of results) {
      lines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
    }
    lines.push(PKT_FLUSH);
    return sidebandWrap(Buffer.concat(lines));
  };
  const packBytes = decoded.rest;
  if (packBytes.length > 0) {
    let entries;
    try {
      entries = readPack(packBytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'pack parse failed';
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-result',
        body: report(false, reason, commands.map((c) => ({ ref: c.ref, ok: false, reason }))),
      };
    }
    for (const entry of entries) store.objects.putRaw(entry.oid, entry.type, entry.data);
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const current = store.getRef(repo, cmd.ref);
    const currentOrZero = current ?? ZERO_OID;
    if (cmd.old !== ZERO_OID && cmd.old !== currentOrZero) {
      results.push({ ref: cmd.ref, ok: false, reason: 'remote ref updated since checkout' });
      continue;
    }
    if (cmd.next === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
        continue;
      }
      store.deleteRef(repo, cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const newObj = store.objects.get(cmd.next);
    if (!newObj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.old === ZERO_OID && current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' });
      continue;
    }
    if (cmd.old !== ZERO_OID && cmd.ref.startsWith('refs/heads/')) {
      const oldObj = store.objects.get(cmd.old);
      if (oldObj && oldObj.type === 'commit' && newObj.type === 'commit') {
        if (!isAncestor(store.objects, cmd.old, cmd.next)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
    }
    store.setRef(repo, cmd.ref, cmd.next);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report(true, null, results) };
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
        const host = req.headers.host ?? 'localhost';
        const baseUrl = `http://${host}`;

        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          let body: Buffer;
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { message: 'Request body too large' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const out = handleGraphQL(store, parsed);
          sendJson(res, out.status, out.json);
          return;
        }

        if (segments[0] === 'mcp') {
          if (method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          let body: Buffer;
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { message: 'Request body too large' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const out = handleMcp(store, parsed);
          if (out.json === null) {
            res.writeHead(out.status);
            res.end();
            return;
          }
          sendJson(res, out.status, out.json);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          let parsed: unknown = undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            let body: Buffer;
            try {
              body = await readBody(req);
            } catch {
              sendJson(res, 400, { message: 'Request body too large' });
              return;
            }
            if (body.length > 0) {
              try {
                parsed = JSON.parse(body.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const out = handleRest(store, { method, segments, query: url.searchParams, body: parsed, baseUrl });
          if (out.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, out.status, out.json ?? {}, out.headers ?? {});
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/info/refs and .../git-upload-pack / .../git-receive-pack
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service === 'git-upload-pack') {
              const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              if (version2) {
                const repo = store.getRepo(owner, repoName);
                if (!repo) {
                  sendJson(res, 404, { message: 'Not Found' });
                  return;
                }
                sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
                return;
              }
              const adv = v0Advertisement('upload-pack', owner, repoName);
              if (adv === null) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', adv);
              return;
            }
            if (service === 'git-receive-pack') {
              const adv = v0Advertisement('receive-pack', owner, repoName);
              if (adv === null) {
                sendJson(res, 404, { message: 'Not Found' });
                return;
              }
              sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', adv);
              return;
            }
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (segments[2] === 'git-upload-pack' && method === 'POST') {
            let body: Buffer;
            try {
              body = await readBody(req);
            } catch {
              sendJson(res, 400, { message: 'Request body too large' });
              return;
            }
            const out = handleUploadPack(owner, repoName, body);
            if (out === null) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            if (out.contentType === 'application/json') {
              sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
              return;
            }
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          if (segments[2] === 'git-receive-pack' && method === 'POST') {
            let body: Buffer;
            try {
              body = await readBody(req);
            } catch {
              sendJson(res, 400, { message: 'Request body too large' });
              return;
            }
            const out = handleReceivePack(owner, repoName, body);
            if (out === null) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            if (out.contentType === 'application/json') {
              sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
              return;
            }
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  return server;
}
