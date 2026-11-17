// rest.ts — the GitHub REST v3 surface under /api/v3.
// Every reply is application/json with a non-empty X-GitHub-Request-Id; unknown routes and
// missing resources answer 404 {"message": ...}; malformed JSON is caught in app.ts (400).

import { FIXED_NOW_ISO, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { parseCommit } from './git.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  /** Pre-serialized JSON body: when set, it is sent verbatim instead of stringifying `json`. */
  text?: string;
}

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** node_id values are deterministic per (type, number): compute each once. */
const nodeIdCache = new Map<string, string>();

export function nodeId(prefix: string, n: number): string {
  const key = `${prefix}:${n}`;
  let cached = nodeIdCache.get(key);
  if (cached === undefined) {
    cached = Buffer.from(`${prefix}:${n}`, 'utf8').toString('base64');
    nodeIdCache.set(key, cached);
  }
  return cached;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestResponse {
  return { status, json, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: FIXED_NOW_ISO,
    pushed_at: FIXED_NOW_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.openIssueCount,
  };
}

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

/** The issue's REST JSON, serialized once and reused until a mutation clears it. */
export function issueJsonString(issue: Issue): string {
  let cached = issue.cachedJson;
  if (cached === null) {
    cached = JSON.stringify(issueView(issue));
    issue.cachedJson = cached;
  }
  return cached;
}

function okText(status: number, text: string, headers?: Record<string, string>): RestResponse {
  return { status, text, headers };
}

function pullView(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = store.getRef(repo, store.refName(pr.headRef)) ?? pr.headSha;
  const baseSha = store.getRef(repo, store.refName(pr.baseRef)) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: nodeId('PullRequest', pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: headSha, label: `${VIEWER.login}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: baseSha, label: `${VIEWER.login}:${pr.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageLink(baseUrl: string, path: string, page: number, perPage: number, rel: string): string {
  return `<${baseUrl}${path}?page=${page}&per_page=${perPage}>; rel="${rel}"`;
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const { method, segments } = req;
  // segments[0..1] are 'api' 'v3'.
  const tail = segments.slice(2);

  if (tail.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {}, { 'X-Oauth-Scopes': 'repo, read:org' });
  }

  if (tail[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  if (tail[0] === 'user') {
    if (tail.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: nodeId('User', VIEWER.id),
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
      });
    }
    if (tail[1] === 'repos') {
      if (method === 'POST') {
        const body = isRecord(req.body) ? req.body : {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        if (store.getRepo(VIEWER.login, name)) return err(422, 'name already exists on this account');
        const description = typeof body.description === 'string' ? body.description : '';
        const isPrivate = body.private === true;
        const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
        return ok(201, repoView(repo));
      }
      if (method === 'GET') {
        const { page, perPage } = parsePage(req.query);
        const all = store.listRepos(VIEWER.login);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const headers: Record<string, string> = {};
        const totalPages = Math.max(1, Math.ceil(all.length / perPage));
        const links: string[] = [];
        const path = '/api/v3/user/repos';
        if (page < totalPages) links.push(pageLink(req.baseUrl, path, page + 1, perPage, 'next'));
        if (page > 1) links.push(pageLink(req.baseUrl, path, page - 1, perPage, 'prev'));
        links.push(pageLink(req.baseUrl, path, 1, perPage, 'first'));
        links.push(pageLink(req.baseUrl, path, totalPages, perPage, 'last'));
        if (links.length > 0) headers.Link = links.join(', ');
        return ok(200, slice.map(repoView), headers);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'repos') {
    const owner = tail[1] ?? '';
    const name = tail[2] ?? '';
    const repo = owner && name ? store.getRepo(owner, name) : undefined;
    if (!repo) return err(404, 'Not Found');
    const rest = tail.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoView(repo));
      if (method === 'PATCH') {
        const body = isRecord(req.body) ? req.body : {};
        if (typeof body.description === 'string') repo.description = body.description;
        return ok(200, repoView(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204 };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const out = store.listRefs(repo)
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
        return ok(200, out);
      }
      if (method === 'GET' && rest.length === 2) {
        const oid = store.getRef(repo, store.refName(rest[1]));
        if (!oid) return err(404, 'Not Found');
        return ok(200, { name: rest[1], commit: { sha: oid }, protected: false });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = isRecord(req.body) ? req.body : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
        if (store.getRef(repo, ref)) return err(422, 'Reference already exists');
        const obj = store.objects.get(sha);
        if (!obj) return err(422, 'Object does not exist');
        store.setRef(repo, ref, sha);
        return ok(201, { ref, object: { sha, type: obj.type } });
      }
      if (method === 'GET' && rest.length >= 3) {
        // GET /git/refs/heads/<branch>
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = store.getRef(repo, ref);
        if (!oid) return err(404, 'Not Found');
        const obj = store.objects.get(oid);
        return ok(200, { ref, object: { sha: oid, type: obj?.type ?? 'commit' } });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const ref = req.query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (!tip) return err(404, 'Not Found');
        const { page, perPage } = parsePage(req.query);
        const all = store.branchCommits(repo, ref);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const out = slice.map((oid) => {
          const obj = store.objects.get(oid);
          const parsed = obj ? parseCommit(obj.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
          const who = (line: string): { name: string; email: string; date: string } => {
            const m = line.match(/^(.*) <(.*)> (\d+) \+0000$/);
            if (!m) return { name: VIEWER.name, email: VIEWER.email, date: FIXED_NOW_ISO };
            return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
          };
          return {
            sha: oid,
            commit: {
              // The stored object ends the message with "\n" (git convention);
              // the REST view reports it without the trailing newline.
              message: parsed.message.replace(/\n+$/, ''),
              author: who(parsed.author),
              committer: who(parsed.committer),
            },
            parents: parsed.parents.map((p) => ({ sha: p })),
          };
        });
        return ok(200, out);
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refParam = req.query.get('ref') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, refParam);
      if (method === 'GET') {
        if (!tip) return err(404, 'Not Found');
        const tree = store.commitTree(tip);
        if (!tree) return err(404, 'Not Found');
        const file = path === '' ? undefined : store.readPath(tree, path);
        if (file) {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop() ?? path,
            path,
            sha: file.oid,
            content: file.data.toString('base64'),
          });
        }
        const entries = store.listPath(tree, path);
        if (entries) {
          return ok(
            200,
            entries.map((e) => {
              const base: Record<string, unknown> = {
                type: e.mode === '40000' ? 'dir' : 'file',
                name: e.name,
                path: path === '' ? e.name : `${path}/${e.name}`,
                sha: e.oid,
              };
              if (e.mode !== '40000') {
                const blob = store.objects.get(e.oid);
                base.size = blob ? blob.data.length : 0;
              }
              return base;
            }),
          );
        }
        return err(404, 'Not Found');
      }
      if (method === 'PUT') {
        if (path === '') return err(404, 'Not Found');
        const body = isRecord(req.body) ? req.body : {};
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        let parentOid = store.getRef(repo, store.refName(branch));
        if (!parentOid) parentOid = store.getRef(repo, store.refName(repo.defaultBranch)) ?? null;
        const parentTree = parentOid ? store.commitTree(parentOid) : null;
        const existing = parentTree ? store.readPath(parentTree, path) : undefined;
        if (existing) {
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (sha !== existing.oid) return err(409, 'sha does not match the current file');
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const { commitOid, blobOid } = store.commitFile(repo, branch, path, content, message, parentOid);
        return ok(existing ? 200 : 201, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobOid,
            size: content.length,
            encoding: 'base64',
          },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        if (path === '') return err(404, 'Not Found');
        const body = isRecord(req.body) ? req.body : {};
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const parentOid = store.getRef(repo, store.refName(branch));
        if (!parentOid) return err(404, 'Not Found');
        const parentTree = store.commitTree(parentOid);
        if (!parentTree) return err(404, 'Not Found');
        const existing = store.readPath(parentTree, path);
        if (!existing) return err(404, 'Not Found');
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (sha !== '' && sha !== existing.oid) return err(409, 'sha does not match the current file');
        const commitOid = store.deleteFile(repo, branch, path, message, parentOid);
        if (!commitOid) return err(404, 'Not Found');
        return ok(200, { commit: { sha: commitOid, message } });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = isRecord(req.body) ? req.body : {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        if (name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'label already exists');
        const label = { id: repo.labels.size + 1, name, color, description: '' };
        repo.labels.set(name, label);
        return ok(201, label);
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return err(422, 'title is required');
          const labelNames = Array.isArray(body.labels)
            ? body.labels.filter((l): l is string => typeof l === 'string')
            : [];
          const created = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
          if ('error' in created) return err(422, created.error);
          return okText(201, issueJsonString(created));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'asc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
          }
          const { page, perPage } = parsePage(req.query);
          return ok(200, list.slice((page - 1) * perPage, page * perPage).map(issueView));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const issue = repo.issues.get(num);
      if (!issue) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return okText(200, issueJsonString(issue));
        if (method === 'PATCH') {
          const body = isRecord(req.body) ? req.body : {};
          if (typeof body.title === 'string') {
            issue.title = body.title;
            issue.cachedJson = null;
          }
          if (typeof body.body === 'string') {
            issue.body = body.body;
            issue.cachedJson = null;
          }
          if (body.state === 'open' || body.state === 'closed') store.setIssueState(repo, issue, body.state);
          issue.updatedAt = FIXED_NOW_ISO;
          return okText(200, issueJsonString(issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') return err(422, 'body is required');
          const comment = store.addComment(repo, issue, commentBody);
          return ok(201, {
            id: comment.id,
            body: comment.body,
            user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          });
        }
        if (method === 'GET') {
          return ok(
            200,
            issue.comments.map((c) => ({
              id: c.id,
              body: c.body,
              user: { login: c.userLogin, id: VIEWER.id, type: 'User' },
              created_at: c.createdAt,
              updated_at: c.createdAt,
            })),
          );
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const created = store.createPullRequest(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) return err(422, created.error);
          return ok(201, pullView(store, repo, created));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => a.seq - b.seq);
          const { page, perPage } = parsePage(req.query);
          return ok(200, list.slice((page - 1) * perPage, page * perPage).map((p) => pullView(store, repo, p)));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      const pr = repo.pulls.get(num);
      if (!pr) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, pullView(store, repo, pr));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && method === 'GET') {
        const files = store.prFiles(repo, pr);
        return ok(
          200,
          files.map((f) => ({
            filename: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        );
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (pr.state === 'closed') return err(405, 'Pull request is already closed');
        if (store.prConflicted(repo, pr)) return err(405, 'Merge conflict');
        const sha = store.mergePullRequest(repo, pr);
        if (!sha) return err(405, 'Merge conflict');
        return ok(200, { sha, merged: true, message: `Pull request #${pr.number} merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
