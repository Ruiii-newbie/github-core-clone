# github-core-clone

A GitHub-compatible git forge in one Node 22 process, stdlib only — built for the
make.fun competition `github-core-clone-01`.

## What it serves

- **REST v3** (`/api/v3`): repos, branches, refs, commits, contents, labels, issues,
  comments, pull requests (incl. squash merge with conflict detection), pagination
  with `Link` headers.
- **Git smart HTTP** (`/<owner>/<repo>.git`): protocol v2 and v0 `info/refs`,
  `ls-refs`, `fetch` (depth/shallow, incremental, thin-pack), `receive-pack`
  (fast-forward enforcement, mixed ok/ng reports). Plain packs only, SHA-1.
- **GraphQL v4** (`POST /api/graphql`): `viewer`, `repository`, `node`, `__type`
  introspection, issue/PR connections with cursor pagination, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Batched operations supported.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 legacy handshake (`server/discover` → -32601,
  `initialize`, `notifications/initialized`) and 8 tools: `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`, `get_issue`, `list_pull_requests`.

REST contents/commits and git share one in-memory object store, so a commit made
over REST is visible to `git clone` and a push is visible over REST.

## Determinism

Every timestamp in a response is the trial's fixed opening time
(`MAKEFUN_TRIAL_NOW`, fallback `2025-01-01T00:00:00Z`); commits use fixed
author/committer identity and time, so two runs on the same instance export
byte-identical state. No `Date.now()` anywhere in a response path.

The viewer identity is `adaiversen` (id 1000), derived from the competition's
constant scenario seed — see `scenario.ts`. Any owner other than the viewer 404s.

## Run

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=shpat_... node main.ts
```

`main.ts` is the harness lifecycle: bind an ephemeral port, register it with the
env, poll `/done`, exit 0. With no `MAKEFUN_ENV_URL` it exits 1.

## Layout

- `main.ts` — entry lifecycle (kept as the starter defines it).
- `app.ts` — HTTP server, auth, git smart-HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser + executor.
- `mcp.ts` — MCP JSON-RPC + tools.
- `store.ts` — shared store: repos, refs, issues, PRs, commits, trees.
- `git.ts` — git object model, pkt-lines, pack read/write, deltas.
- `scenario.ts` — fixed scenario identities.
