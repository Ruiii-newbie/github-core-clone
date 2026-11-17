// graphql.ts — a small GraphQL executor for the fixed documents the suite sends.
// It parses query/mutation documents (aliases, variables, inline args, inline fragments,
// batched arrays) and validates field names against the schema tables below, so an unknown
// field answers 200 with an `errors` entry naming the field, GitHub-style.

import { FIXED_NOW_ISO, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- global ids

export function encodeGlobalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    if (!/^[A-Za-z]+$/.test(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- parser

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  children: FieldNode[] | null;
  typeCondition: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === '#') {
        if (ch === '#') {
          while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        } else this.pos += 1;
      } else break;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.text[this.pos] ?? '';
  }

  private take(expected?: string): string {
    this.skipWs();
    if (expected !== undefined) {
      if (this.text.slice(this.pos, this.pos + expected.length) !== expected) {
        throw new Error(`expected "${expected}" at ${this.pos}`);
      }
      this.pos += expected.length;
      return expected;
    }
    return this.text[this.pos++];
  }

  private name(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private string(): string {
    this.take('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++];
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.pos++];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
      } else out += ch;
    }
    throw new Error('unterminated string');
  }

  private value(variables: Record<string, Value>): Value {
    const ch = this.peek();
    if (ch === '"') return this.string();
    if (ch === '[') {
      this.take('[');
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.value(variables));
      this.take(']');
      return items;
    }
    if (ch === '{') {
      this.take('{');
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.name();
        this.take(':');
        obj[key] = this.value(variables);
      }
      this.take('}');
      return obj;
    }
    if (ch === '$') {
      this.take('$');
      const varName = this.name();
      if (!(varName in variables)) throw new Error(`variable $${varName} is not defined`);
      return variables[varName];
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.pos));
      if (!m) throw new Error(`expected number at ${this.pos}`);
      this.pos += m[0].length;
      return m[0].includes('.') ? Number.parseFloat(m[0]) : Number.parseInt(m[0], 10);
    }
    const word = this.name();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (/^-?\d+$/.test(word)) return Number.parseInt(word, 10);
    if (/^-?\d*\.\d+$/.test(word)) return Number.parseFloat(word);
    return word; // enum value, kept as its name
  }

  private skipVariableDefinitions(): void {
    if (this.peek() !== '(') return;
    this.take('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.text.length) {
      const ch = this.text[this.pos++];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === '"') {
        while (this.pos < this.text.length && this.text[this.pos] !== '"') {
          if (this.text[this.pos] === '\\') this.pos += 1;
          this.pos += 1;
        }
        this.pos += 1;
      }
    }
  }

  private arguments(variables: Record<string, Value>): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek() !== '(') return args;
    this.take('(');
    while (this.peek() !== ')') {
      const key = this.name();
      this.take(':');
      args[key] = this.value(variables);
    }
    this.take(')');
    return args;
  }

  private selectionSet(variables: Record<string, Value>): FieldNode[] {
    this.take('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.text.slice(this.pos).startsWith('...')) {
        this.take('...');
        if (this.peek() === 'o' || this.text.slice(this.pos, this.pos + 2) === 'on') {
          this.take('on');
          const typeCondition = this.name();
          const children = this.selectionSet(variables);
          for (const child of children) fields.push({ ...child, typeCondition });
        } else {
          // Named fragment spread: not used by the suite; skip its selection set.
          this.name();
          this.selectionSet(variables);
        }
        continue;
      }
      let alias: string | null = null;
      let fieldName = this.name();
      if (this.peek() === ':') {
        this.take(':');
        alias = fieldName;
        fieldName = this.name();
      }
      const args = this.arguments(variables);
      const children = this.peek() === '{' ? this.selectionSet(variables) : null;
      fields.push({ alias, name: fieldName, args, children, typeCondition: null });
    }
    this.take('}');
    return fields;
  }

  parseOperation(variables: Record<string, Value>): Operation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    const word = this.peek();
    if (word === 'q' || word === 'm') {
      const kw = this.name();
      if (kw === 'mutation') kind = 'mutation';
      else if (kw !== 'query') throw new Error(`unexpected keyword ${kw}`);
    }
    let opName: string | null = null;
    if (this.peek() !== '{' && this.peek() !== '(') opName = this.name();
    this.skipVariableDefinitions();
    const fields = this.selectionSet(variables);
    return { kind, name: opName, fields };
  }
}

// ---------------------------------------------------------------- schema tables

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'mergedAt', 'mergeCommit',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  Ref: ['name'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = [
  'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'PROJECT',
];

// ---------------------------------------------------------------- executor

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

interface Context {
  store: Store;
  errors: { message: string }[];
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'CLOSED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: encodeGlobalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function prObject(store: Store, repo: Repo, pr: PullRequest): GqlObject {
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pr: pr,
    id: encodeGlobalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: prState(pr),
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommitSha ? { __type: 'Commit', oid: pr.mergeCommitSha } : null,
  };
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return {
    __type: 'Repository',
    __repo: repo,
    id: encodeGlobalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
  };
}

function resolveField(ctx: Context, obj: GqlObject, field: FieldNode): unknown {
  const typeName = obj.__type;
  const known = SCHEMA_FIELDS[typeName] ?? [];
  if (field.name === '__typename') return typeName;
  if (!known.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const store = ctx.store;
  switch (typeName) {
    case 'User':
      if (field.name === 'login') return VIEWER.login;
      if (field.name === 'id') return VIEWER.id;
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      return null;
    case 'Repository': {
      const repo = obj.__repo as Repo;
      if (field.name === 'owner') {
        return { __type: 'User', login: repo.owner, id: VIEWER.id, name: repo.owner };
      }
      if (field.name === 'defaultBranchRef') {
        const oid = store.getRef(repo, store.refName(repo.defaultBranch));
        return oid ? { __type: 'Ref', name: repo.defaultBranch } : null;
      }
      if (field.name === 'issue') {
        const num = field.args.number as number;
        const issue = repo.issues.get(num);
        return issue ? issueObject(store, repo, issue) : null;
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, field.args);
      if (field.name === 'pullRequest') {
        const num = field.args.number as number;
        const pr = repo.pulls.get(num);
        return pr ? prObject(store, repo, pr) : null;
      }
      if (field.name === 'pullRequests') return prsConnection(ctx, repo, field.args);
      return obj[field.name] ?? null;
    }
    case 'Issue':
      return obj[field.name] ?? null;
    case 'PullRequest': {
      const repo = obj.__repo as Repo;
      const pr = obj.__pr as PullRequest;
      if (field.name === 'mergeable') {
        return store.prConflicted(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'files') {
        const first = typeof field.args.first === 'number' ? field.args.first : 100;
        const files = store.prFiles(repo, pr).slice(0, first);
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: files.map((f) => ({
            __type: 'PullRequestChangedFile',
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      return obj[field.name] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'PageInfo':
    case 'IssueEdge':
    case 'PullRequestEdge':
    case '__Type':
    case '__Field':
    case '__EnumValue':
      return obj[field.name] ?? null;
    default:
      return obj[field.name] ?? null;
  }
}

function issuesConnection(ctx: Context, repo: Repo, args: Record<string, Value>): GqlObject {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(issueState(i)));
  }
  const orderBy = args.orderBy as Record<string, Value> | undefined;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  const field = orderBy && typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  if (field === 'CREATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  }
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? cursorIndex(args.after) : -1;
  const start = after + 1;
  const slice = list.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __type: 'IssueConnection',
    nodes: slice.map((i) => issueObject(ctx.store, repo, i)),
    totalCount: list.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + slice.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

function prsConnection(ctx: Context, repo: Repo, args: Record<string, Value>): GqlObject {
  const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? cursorIndex(args.after) : -1;
  const start = after + 1;
  const slice = list.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __type: 'PullRequestConnection',
    nodes: slice.map((p) => prObject(ctx.store, repo, p)),
    totalCount: list.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + slice.length < list.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

function executeSelection(ctx: Context, obj: GqlObject, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.typeCondition && field.typeCondition !== obj.__type) continue;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, obj, field);
    out[key] = value === null || value === undefined ? null : applySelection(ctx, value, field.children);
  }
  return out;
}

function applySelection(ctx: Context, value: unknown, children: FieldNode[] | null): unknown {
  if (children === null || children === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => applySelection(ctx, v, children));
  if (typeof value === 'object' && value !== null) {
    return executeSelection(ctx, value as GqlObject, children);
  }
  return value;
}

function resolveRoot(ctx: Context, op: Operation, field: FieldNode): unknown {
  const store = ctx.store;
  if (op.kind === 'query') {
    if (field.name === 'viewer') {
      return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'repository') {
      const owner = field.args.owner as string;
      const name = field.args.name as string;
      const repo = store.getRepo(owner, name);
      return repo ? repoObject(store, repo) : null;
    }
    if (field.name === 'node') {
      const decoded = decodeGlobalId(field.args.id as string);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        return repo ? repoObject(store, repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo && issue ? issueObject(store, repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]));
        const pr = repo?.pulls.get(Number(decoded.parts[1]));
        return repo && pr ? prObject(store, repo, pr) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const typeName = field.args.name as string;
      if (typeName === 'Issue' || typeName === 'PullRequest' || typeName === 'Repository') {
        const fields = (SCHEMA_FIELDS[typeName] ?? []).map((f) => ({
          __type: '__Field',
          name: f,
          description: null,
        }));
        return { __type: '__Type', name: typeName, kind: 'OBJECT', fields, enumValues: null };
      }
      if (typeName === 'SearchType') {
        return {
          __type: '__Type',
          name: typeName,
          kind: 'ENUM',
          fields: null,
          enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __type: '__EnumValue', name: v, description: null })),
        };
      }
      return null;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return null;
  }
  // Mutations.
  const input = (field.args.input ?? {}) as Record<string, Value>;
  if (field.name === 'createIssue') {
    const decoded = decodeGlobalId(input.repositoryId as string);
    const repo = decoded?.kind === 'Repository'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const created = store.createIssue(repo, title, body, []);
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    return { __type: 'CreateIssuePayload', issue: issueObject(store, repo, created) };
  }
  if (field.name === 'closeIssue') {
    const decoded = decodeGlobalId(input.issueId as string);
    const repo = decoded?.kind === 'Issue'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    store.setIssueState(repo, issue, 'closed');
    issue.updatedAt = FIXED_NOW_ISO;
    return { __type: 'CloseIssuePayload', issue: issueObject(store, repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const decoded = decodeGlobalId(input.repositoryId as string);
    const repo = decoded?.kind === 'Repository'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const created = store.createPullRequest(
      repo,
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
      typeof input.headRefName === 'string' ? input.headRefName : '',
      typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
    );
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    return { __type: 'CreatePullRequestPayload', pullRequest: prObject(store, repo, created) };
  }
  if (field.name === 'mergePullRequest') {
    const decoded = decodeGlobalId(input.pullRequestId as string);
    const repo = decoded?.kind === 'PullRequest'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    const pr = repo?.pulls.get(Number(decoded?.parts[1] ?? NaN));
    if (!repo || !pr) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return null;
    }
    const sha = store.mergePullRequest(repo, pr);
    if (!sha) {
      ctx.errors.push({ message: 'Pull request cannot be merged.' });
      return null;
    }
    return { __type: 'MergePullRequestPayload', pullRequest: prObject(store, repo, pr) };
  }
  if (field.name === 'addComment') {
    const decoded = decodeGlobalId(input.subjectId as string);
    const repo = decoded?.kind === 'Issue'
      ? [...store.repos.values()].find((r) => r.id === Number(decoded.parts[0]))
      : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1] ?? NaN));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    const comment = store.addComment(repo, issue, typeof input.body === 'string' ? input.body : '');
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'IssueEdge',
        node: {
          __type: 'IssueComment',
          id: encodeGlobalId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
        },
        cursor: cursorFor(issue.comments.length - 1),
      },
    };
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, Value>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Context = { store, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const field of op.fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      data[key] = rootType;
      continue;
    }
    const known = SCHEMA_FIELDS[rootType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${rootType}".` });
      data[key] = null;
      continue;
    }
    const value = resolveRoot(ctx, op, field);
    data[key] = value === null || value === undefined ? null : applySelection(ctx, value, field.children);
  }
  return { data, errors: ctx.errors };
}

/** Handle one parsed GraphQL request body (object or array). Returns the response body. */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const runOne = (item: unknown): Record<string, unknown> => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
    }
    const record = item as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    if (query === '') return { errors: [{ message: 'Must provide query string.' }] };
    const variables = (record.variables ?? {}) as Record<string, Value>;
    let op: Operation;
    try {
      op = new Parser(query).parseOperation(variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
    }
    const { data, errors } = executeOperation(store, op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}
