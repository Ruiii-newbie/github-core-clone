// mcp.ts — the MCP endpoint (POST /mcp, JSON-RPC 2.0 streamable HTTP, legacy era).
// `server/discover` answers -32601 so the client falls back to the initialize handshake.
// Every request echoes its own id; notifications (no id) answer 202 with an empty body.
// Tools act on the same store as REST and GraphQL.

import { FIXED_NOW_ISO, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'integer', description: 'Issue number.' },
        issue_number: { type: 'integer', description: 'Issue number (alias).' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function prJson(pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: typeof value === 'object' && value !== null ? value : { result: value } };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const num = (key: string): number => {
    const value = args[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) ? parsed : NaN;
    }
    return NaN;
  };

  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') return errorResult('Missing required argument: name');
      if (store.getRepo(VIEWER.login, repoName)) return errorResult('name already exists on this account');
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        str('description'),
        args.private === true,
      );
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      if (str('title') === '') return errorResult('Missing required argument: title');
      const created = store.createIssue(repo, str('title'), str('body'), []);
      if ('error' in created) return errorResult(created.error);
      return textResult(issueJson(created));
    }
    case 'list_issues': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      const state = str('state') || 'open';
      const list = [...repo.issues.values()]
        .filter((i) => (state === 'all' ? true : i.state === state))
        .sort((a, b) => a.seq - b.seq)
        .map(issueJson);
      return textResult(list);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      if (str('title') === '' || str('head') === '' || str('base') === '') {
        return errorResult('Missing required argument: title, head and base are required');
      }
      const created = store.createPullRequest(repo, str('title'), str('body'), str('head'), str('base'));
      if ('error' in created) return errorResult(created.error);
      return textResult(prJson(created));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      const pullNumber = num('pull_number');
      if (!Number.isInteger(pullNumber)) return errorResult('Missing required argument: pull_number');
      const pr = repo.pulls.get(pullNumber);
      if (!pr) return errorResult('Not Found');
      if (pr.state === 'closed') return errorResult('Pull request is already closed');
      if (store.prConflicted(repo, pr)) return errorResult('Merge conflict');
      const sha = store.mergePullRequest(repo, pr);
      if (!sha) return errorResult('Merge conflict');
      return textResult({ merged: true, number: pr.number, sha, state: 'closed' });
    }
    case 'get_issue': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      const issueNumber = Number.isInteger(num('number')) ? num('number') : num('issue_number');
      if (!Number.isInteger(issueNumber)) return errorResult('Missing required argument: number');
      const issue = repo.issues.get(issueNumber);
      if (!issue) return errorResult('Not Found');
      return textResult(issueJson(issue));
    }
    case 'list_pull_requests': {
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return errorResult('Not Found');
      const state = str('state') || 'open';
      const list = [...repo.pulls.values()]
        .filter((p) => (state === 'all' ? true : p.state === state))
        .sort((a, b) => a.seq - b.seq)
        .map(prJson);
      return textResult(list);
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** Handle one JSON-RPC request object. Returns {status, json} (json null => empty body). */
function handleOne(store: Store, req: unknown): { status: number; json: unknown } {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const record = req as Record<string, unknown>;
  const id = 'id' in record ? record.id : undefined;
  const isNotification = id === undefined;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): { status: number; json: unknown } =>
    isNotification ? { status: 202, json: null } : { status: 200, json: { jsonrpc: '2.0', id, result: value } };
  const rpcError = (code: number, message: string): { status: number; json: unknown } =>
    isNotification
      ? { status: 202, json: null }
      : { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };

  if (method === 'notifications/initialized') return { status: 202, json: null };
  if (method === '') return rpcError(-32600, 'Invalid Request: missing method');

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : '2025-11-25';
      return result({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return rpcError(-32602, `Unknown tool: ${toolName}`);
      const required = tool.inputSchema.required ?? [];
      const missing = required.filter((key) => !(key in args) || args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return result({ content: [{ type: 'text', text: `Missing required argument: ${missing.join(', ')}` }], isError: true });
      }
      return result(callTool(store, toolName, args));
    }
    default:
      // server/discover and anything else: method not found (legacy fallback path).
      return rpcError(-32601, `Method not found: ${method}`);
  }
}

/** Handle a POST /mcp body (single object, or a batch array). */
export function handleMcp(store: Store, body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((item) => handleOne(store, item));
    const out = results.map((r) => r.json).filter((j) => j !== null);
    return { status: 200, json: out };
  }
  return handleOne(store, body);
}
