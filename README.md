# Pin Point

Local-first visual review tool. A client clicks elements on your live page, leaves
plain-language comments, and submits. Pin Point maps each comment back to the
source file, runs a coding agent (Claude Code) in an **isolated Git worktree**,
verifies the result, and opens a **draft GitHub pull request** — you decide whether
to merge.

- Client never needs technical knowledge, a browser extension, or GitHub access.
- A client submission **never** runs a coding agent. Only the developer dashboard
  can trigger **Generate Fix PR**.
- Agent edits happen only in a throwaway worktree based on the review's exact
  commit. Your working directory is never touched.
- Failed tests/build block the push and PR. Pull requests are always drafts. Pin
  Point never merges and never force-pushes.

## Prerequisites

- **Node.js 20+** (24 LTS recommended)
- **Git** on your PATH
- **GitHub CLI** (`gh`) authenticated (`gh auth login`) — required for PR creation
- **Claude Code CLI** (`claude`) installed and authenticated — the default agent
- A **clean** local Git repository with a **GitHub remote** to review

Supported project types in this version: plain HTML/CSS/JS, React, and Next.js.

## Install and verify (Windows PowerShell)

```powershell
npm install
npm run typecheck
npm test
npm run build
```

## Start a review

```powershell
npm run dev -- review C:\Users\akp\Downloads\pinpoint
```

Pin Point inspects the repository, starts an instrumented preview, and prints two
URLs:

```text
Review link (send to your client): http://localhost:3000/review/<projectId>
Developer dashboard:               http://localhost:3000/dashboard
```

Send the **review link** to your client. Open the **dashboard** yourself.

### Sharing beyond your machine

`localhost` is local-only. To let others reach the review:

- **LAN:** bind to all interfaces and share your machine's LAN IP:

  ```powershell
  npm run dev -- review C:\path\to\repo --host 0.0.0.0
  ```

  Then send `http://<your-lan-ip>:3000/review/<projectId>`.

- **Remote (internet):** put a tunnel in front of the loopback server (e.g. an
  SSH/HTTP tunnel) or use a future hosted deployment. Only expose review links —
  the dashboard and its developer token stay on loopback.

Options: `--url <public-url>` (proxy an already-deployed page while mapping from
the local repo), `--port <port>`, `--host <host>`.

## The flow

1. **Client reviews.** Opens the review link, clicks elements, comments, enters a
   name, and submits. Comments are kept as a browser draft (surviving refreshes)
   until submission, then stored as JSON.
2. **Developer inspects.** The dashboard lists reviews with per-annotation source
   mappings and a confidence badge (`direct` / `approximate` / `unresolved`).
3. **Developer approves.** Click **Generate Fix PR**. Pin Point creates a worktree
   from the review's commit, runs Claude Code scoped to the feedback, verifies
   (test/lint/typecheck/build as available), commits, pushes a generated
   `pinpoint/review-*` branch, and opens a **draft** PR.
4. **Developer decides.** Review the draft on GitHub and merge, revise, or close.

## Data and cleanup

Runtime state is local JSON under `data/` (`projects.json`, `reviews.json`,
`jobs.json`, sanitized `logs/`). Temporary preview copies and worktrees live under
`.pinpoint/`. Both are git-ignored. Delete them to reset:

```powershell
Remove-Item -Recurse -Force data\*.json, data\logs, .pinpoint -ErrorAction SilentlyContinue
```

## Safety model

Credentials (GitHub, Claude) live on the server and are never sent to review
clients or written to logs (output is secret-redacted). The dashboard's mutation
routes require a per-server developer token embedded only in the locally served
dashboard. See [`docs/visual-feedback-to-autonomous-pr-flow.md`](docs/visual-feedback-to-autonomous-pr-flow.md)
for the full specification and [`docs/local-demo.md`](docs/local-demo.md) for a
step-by-step local walkthrough.

## Development

```powershell
npm run test:watch     # watch mode
npm run typecheck      # tsc --noEmit
npm run build          # compile to dist/
```

Architecture: a TypeScript Node/Express server owns discovery, instrumented
preview serving/proxying, JSON persistence, review/dashboard APIs, job
orchestration, worktrees, agent execution, and draft-PR creation. Browser assets
are framework-free JS/CSS. Instrumentation is adapter-based: parse5 for HTML,
Babel + MagicString for JSX/TSX. The coding agent sits behind a replaceable
interface (`CodingAgent`), with Claude Code as the first runner.
