# Pin Point

Local-first visual review tool. A client clicks elements on your live page, leaves
plain-language comments, and submits. Pin Point maps each comment back to the
source file, runs a coding agent (Claude Code) in an **isolated Git worktree**,
verifies the result, and opens a **draft GitHub pull request** — you decide whether
to merge.

- Client never needs technical knowledge, a browser extension, or GitHub access.
- A client submission **automatically** runs the coding agent and opens a draft
  PR. The **draft PR is the human review gate** — Pin Point never merges it for you.
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
2. **Fix runs automatically.** On submission Pin Point creates a worktree from the
   review's commit, runs Claude Code scoped to the feedback, verifies
   (test/lint/typecheck/build as available), commits, pushes a generated
   `pinpoint/review-*` branch, and opens a **draft** PR — no manual trigger.
3. **Developer inspects.** The dashboard lists reviews with per-annotation source
   mappings, a confidence badge (`direct` / `approximate` / `unresolved`), and the
   live job status; a failed run can be retried from here.
4. **Developer decides.** Review the draft on GitHub and merge, revise, or close.

## Local demo walkthrough

A full local run against Pin Point's own repository. Everything is loopback-only;
the coding job runs automatically on submission, so it only reaches out to
GitHub/Claude if `gh`/`claude` are authenticated (otherwise the job simply fails
at that step and can be retried). Install/verify and start the server as above
(the working tree must be clean first), then play both roles.

**Act as the client:**

1. Open the **review link** in a browser.
2. Click two elements on the landing page (for example a heading and a button).
3. Type a comment for each (e.g. "Make this heading bigger").
4. **Refresh the page** — your draft comments are still there (localStorage draft
   recovery).
5. Enter a name and click **Submit feedback**.

**Act as the developer:**

1. Open the **dashboard**.
2. Select the review. Each comment shows its source mapping back to `index.html`
   with a `direct` confidence badge and a source chip like `index.html:42`.
3. The job already started on submission — watch it move through
   `preparing → running-agent → verifying → pushing → pr-opened` (use **Retry Fix
   PR** if a run failed).
4. On success the dashboard shows a **draft pull request** link. Your local `main`
   is untouched; the change lives on a generated `pinpoint/review-*` branch.

Press **Ctrl+C** to stop (it shuts down the preview and releases the port).

### Troubleshooting

- **"working tree must be clean"** — commit or stash changes before starting.
- **PR step fails** — ensure `gh auth status` is authenticated and the repo has a
  GitHub `origin` remote.
- **Agent step fails** — ensure the `claude` CLI is installed and authenticated.
  The job is marked `failed` with a sanitized reason and the worktree is kept for
  inspection; you can retry from the dashboard.
- **Port in use** — pass `--port <port>`.

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
for the full specification.

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
