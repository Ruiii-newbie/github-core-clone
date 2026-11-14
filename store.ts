// store.ts — one shared in-memory store: git objects, refs and REST metadata.
// REST contents/commits and the git smart-HTTP endpoints read and write the SAME object
// store, so a commit made over REST is visible to `git clone` and vice versa.
//
// Determinism: every timestamp in a response is the trial's fixed opening time
// (MAKEFUN_TRIAL_NOW) or a fixed fallback; nothing here calls Date.now().

import {
  ObjectStore,
  buildTree,
  collectReachable,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  walkCommits,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import { DEFAULT_BRANCH, VIEWER } from './scenario.ts';

export const FIXED_NOW_ISO = process.env.MAKEFUN_TRIAL_NOW ?? '2025-01-01T00:00:00Z';
export const FIXED_NOW_EPOCH = Math.floor(Date.parse(FIXED_NOW_ISO) / 1000) || 1735689600;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  /** Issues and PRs share one per-repo counter, GitHub-style. */
  nextNumber: number;
  seq: number;
  createdAt: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Store {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  /** Creation order per owner, for the paged user/repos list. */
  private readonly ownerRepos = new Map<string, Repo[]>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextSeq = 1;

  // ------------------------------------------------------------ repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** Only repos owned by the viewer exist in this forge; any other owner 404s. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...(this.ownerRepos.get(owner) ?? [])];
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      seq: this.nextSeq++,
      createdAt: FIXED_NOW_ISO,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    const list = this.ownerRepos.get(owner) ?? [];
    list.push(repo);
    this.ownerRepos.set(owner, list);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const list = this.ownerRepos.get(repo.owner) ?? [];
    const index = list.indexOf(repo);
    if (index !== -1) list.splice(index, 1);
  }

  // ------------------------------------------------------------ git refs

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs of a repo, as [refname, oid] pairs in deterministic order (HEAD first by caller). */
  listRefs(repo: Repo): [string, string][] {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    // Accept a full ref, a branch name, or a raw commit sha.
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const asBranch = repo.refs.get(this.refName(ref));
    if (asBranch) return asBranch;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const obj = this.objects.get(ref);
      if (obj && obj.type === 'commit') return ref;
      if (obj && obj.type === 'tag') return parseTag(obj.data).object;
    }
    return undefined;
  }

  // ------------------------------------------------------------ trees

  /** The tree oid of a commit, or undefined when the commit is unknown. */
  commitTree(oid: string): string | undefined {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  /** Read one file (blob bytes) out of a tree, following a '/'-separated path. */
  readPath(treeOid: string, path: string): { oid: string; data: Buffer } | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'tree') return undefined;
      const entries = parseTree(obj.data);
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return undefined;
        return { oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List the entries of the tree at `path` ('' = root). Returns undefined when not a tree. */
  listPath(treeOid: string, path: string): TreeEntry[] | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (const part of parts) {
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    const obj = this.objects.get(current);
    if (!obj || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }

  /** Return a new tree oid with `path` set to `blobOid` (or deleted when blobOid is null),
   *  creating intermediate trees as needed. */
  private setPathInTree(treeOid: string | null, parts: string[], blobOid: string | null, mode = '100644'): string {
    const entries: TreeEntry[] = treeOid ? parseTree(this.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const [head, ...rest] = parts;
    const index = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index !== -1) {
        entries[index] = { mode, name: head, oid: blobOid };
      } else {
        entries.push({ mode, name: head, oid: blobOid });
      }
    } else {
      const childTree = index !== -1 && entries[index].mode === '40000' ? entries[index].oid : null;
      const newChild = this.setPathInTree(childTree, rest, blobOid, mode);
      if (index !== -1) {
        entries[index] = { mode: '40000', name: head, oid: newChild };
      } else {
        entries.push({ mode: '40000', name: head, oid: newChild });
      }
    }
    return this.objects.put('tree', buildTree(entries));
  }

  /** Create a commit on `branch` that changes one file, returning the commit oid.
   *  `parentOid` is the branch tip (null for the first commit). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    parentOid: string | null,
  ): { commitOid: string; blobOid: string } {
    const blobOid = this.objects.put('blob', content);
    const parentTree = parentOid ? this.commitTree(parentOid) ?? null : null;
    const newTree = this.setPathInTree(parentTree, path.split('/').filter((p) => p !== ''), blobOid);
    const commitOid = this.makeCommit(newTree, parentOid ? [parentOid] : [], message);
    this.setRef(repo, this.refName(branch), commitOid);
    return { commitOid, blobOid };
  }

  /** Delete one file on `branch`, returning the commit oid (null when the file was absent). */
  deleteFile(repo: Repo, branch: string, path: string, message: string, parentOid: string): string | null {
    const parentTree = this.commitTree(parentOid);
    if (!parentTree) return null;
    if (!this.readPath(parentTree, path)) return null;
    const newTree = this.setPathInTree(parentTree, path.split('/').filter((p) => p !== ''), null);
    const commitOid = this.makeCommit(newTree, [parentOid], message);
    this.setRef(repo, this.refName(branch), commitOid);
    return commitOid;
  }

  makeCommit(treeOid: string, parents: string[], message: string): string {
    const who = `${VIEWER.name} <${VIEWER.email}> ${FIXED_NOW_EPOCH} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '', message.endsWith('\n') ? message : `${message}\n`);
    return this.objects.put('commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  makeTag(objectOid: string, type: 'commit', tagName: string, message: string): string {
    const who = `${VIEWER.name} <${VIEWER.email}> ${FIXED_NOW_EPOCH} +0000`;
    const text = `object ${objectOid}\ntype ${type}\ntag ${tagName}\ntagger ${who}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
    return this.objects.put('tag', Buffer.from(text, 'utf8'));
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: this.nextSeq++,
      createdAt: FIXED_NOW_ISO,
      updatedAt: FIXED_NOW_ISO,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextCommentId++,
      body,
      userLogin: VIEWER.login,
      createdAt: FIXED_NOW_ISO,
    };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | { error: string } {
    const headOid = this.getRef(repo, this.refName(headRef));
    const baseOid = this.getRef(repo, this.refName(baseRef));
    if (!headOid) return { error: `head branch "${headRef}" does not exist` };
    if (!baseOid) return { error: `base branch "${baseRef}" does not exist` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        return { error: 'a pull request already exists for this head branch' };
      }
    }
    const pr: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha: headOid,
      baseSha: baseOid,
      seq: this.nextSeq++,
      createdAt: FIXED_NOW_ISO,
      updatedAt: FIXED_NOW_ISO,
    };
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /** Current tip of a PR's head/base branch (branches may advance after creation). */
  private prTip(repo: Repo, pr: PullRequest, side: 'head' | 'base'): string {
    const ref = side === 'head' ? pr.headRef : pr.baseRef;
    const fallback = side === 'head' ? pr.headSha : pr.baseSha;
    return this.getRef(repo, this.refName(ref)) ?? fallback;
  }

  /** The three-way file diff between the merge-base tree and the head tree. */
  prFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const headSha = this.prTip(repo, pr, 'head');
    const baseSha = this.prTip(repo, pr, 'base');
    const headTree = this.commitTree(headSha);
    const baseTree = this.commitTree(baseSha);
    const mergeBaseOid = mergeBase(this.objects, headSha, baseSha);
    const baseOfTree = mergeBaseOid ? this.commitTree(mergeBaseOid) : null;
    if (!headTree || !baseTree) return [];
    const flatten = (treeOid: string | null): Map<string, { oid: string; data: Buffer }> => {
      const out = new Map<string, { oid: string; data: Buffer }>();
      if (!treeOid) return out;
      const walk = (oid: string, prefix: string): void => {
        const obj = this.objects.get(oid);
        if (!obj || obj.type !== 'tree') return;
        for (const entry of parseTree(obj.data)) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.mode === '40000') walk(entry.oid, path);
          else {
            const blob = this.objects.get(entry.oid);
            if (blob) out.set(path, { oid: entry.oid, data: blob.data });
          }
        }
      };
      walk(treeOid, '');
      return out;
    };
    const headFiles = flatten(headTree);
    const baseFiles = flatten(baseOfTree);
    const lineCount = (data: Buffer): number => {
      const text = data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const changes: FileChange[] = [];
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of [...paths].sort()) {
      const head = headFiles.get(path);
      const base = baseFiles.get(path);
      if (head && !base) {
        const additions = lineCount(head.data);
        changes.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (!head && base) {
        const deletions = lineCount(base.data);
        changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (head && base && head.oid !== base.oid) {
        const additions = lineCount(head.data);
        const deletions = lineCount(base.data);
        changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /** True when a squash merge of `pr` would conflict: a path changed on both sides of the
   *  merge-base with different resulting contents. */
  prConflicted(repo: Repo, pr: PullRequest): boolean {
    const headSha = this.prTip(repo, pr, 'head');
    const baseSha = this.prTip(repo, pr, 'base');
    const headTree = this.commitTree(headSha);
    const baseTree = this.commitTree(baseSha);
    const mergeBaseOid = mergeBase(this.objects, headSha, baseSha);
    const baseOfTree = mergeBaseOid ? this.commitTree(mergeBaseOid) : null;
    if (!headTree || !baseTree) return false;
    const flatten = (treeOid: string | null): Map<string, string> => {
      const out = new Map<string, string>();
      if (!treeOid) return out;
      const walk = (oid: string, prefix: string): void => {
        const obj = this.objects.get(oid);
        if (!obj || obj.type !== 'tree') return;
        for (const entry of parseTree(obj.data)) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.mode === '40000') walk(entry.oid, path);
          else out.set(path, entry.oid);
        }
      };
      walk(treeOid, '');
      return out;
    };
    const head = flatten(headTree);
    const base = flatten(baseTree);
    const ancestor = flatten(baseOfTree);
    const paths = new Set([...head.keys(), ...base.keys(), ...ancestor.keys()]);
    for (const path of paths) {
      const h = head.get(path);
      const b = base.get(path);
      const a = ancestor.get(path);
      const headChanged = h !== a;
      const baseChanged = b !== a;
      if (headChanged && baseChanged && h !== b) return true;
    }
    return false;
  }

  /** Squash-merge `pr` onto its base branch. Returns the merge commit oid, or null on conflict. */
  mergePullRequest(repo: Repo, pr: PullRequest): string | null {
    if (pr.state !== 'open') return null;
    if (this.prConflicted(repo, pr)) return null;
    const headSha = this.prTip(repo, pr, 'head');
    const headTree = this.commitTree(headSha);
    const baseOid = this.getRef(repo, this.refName(pr.baseRef));
    if (!headTree || !baseOid) return null;
    const message = `Merge pull request #${pr.number} from ${VIEWER.login}/${pr.headRef}\n\n${pr.title}\n`;
    const mergeOid = this.makeCommit(headTree, [baseOid], message);
    this.setRef(repo, this.refName(pr.baseRef), mergeOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_NOW_ISO;
    pr.mergeCommitSha = mergeOid;
    pr.updatedAt = FIXED_NOW_ISO;
    return mergeOid;
  }

  // ------------------------------------------------------------ helpers

  /** Commits of a branch (or raw ref/sha), newest first. */
  branchCommits(repo: Repo, ref: string): string[] {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    return walkCommits(this.objects, tip);
  }

  /** Objects reachable from the given roots, for pack building. */
  reachable(roots: string[]): Map<string, GitObject> {
    return collectReachable(this.objects, roots);
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return isAncestor(this.objects, ancestor, descendant);
  }
}
