# Pin Point

Local-first visual review tool. A client clicks elements on your live page, leaves
plain-language comments, and submits. Pin Point maps each comment to the source
file, runs Claude Code in an isolated Git worktree, and opens a **draft** GitHub
pull request.

- The client needs no technical knowledge, browser extension, or GitHub access.
- Submitting feedback automatically runs the agent and opens a draft PR. The draft
  is the review gate — Pin Point never merges and never force-pushes.
- The agent works only in a throwaway worktree at the review's commit; your working
  tree is untouched.
- A failing build blocks the push and PR.

## Requirements

- Node.js 20+ (24 LTS recommended)
- Git on your PATH
- GitHub auth for PR creation — either the GitHub CLI (`gh auth login`), or a
  stored HTTPS Git credential for github.com (e.g. Git Credential Manager), which
  Pin Point uses to open the PR via the REST API when `gh` isn't available
- Claude Code CLI (`claude`) authenticated — the default agent
- A clean local Git repo with a GitHub remote

Supported projects: plain HTML/CSS/JS, React, Next.js.

## Install

```bash
npx @ankitpandey2708/pinpoint <path-to-repo>   # run without installing
# or:
npm install -g @ankitpandey2708/pinpoint
pinpoint <path-to-repo>                         # omit the path to review the current repo
```

## Usage

`pinpoint <repo>` inspects the repo, starts an instrumented preview, and prints two
URLs. The preferred port is 7777; it steps up (7778, 7779, …) if taken.

```text
Review link (local):    http://localhost:7777/review/<projectId>
Developer dashboard:    http://localhost:7777/dashboard?token=<devToken>
```

Send the **review link** to your client; keep the tokenized **dashboard** link
private. Pin Point also starts a public Cloudflare tunnel and prints public URLs;
if `cloudflared` is unavailable it falls back to local URLs and says how to enable
sharing. Press **Ctrl+C** to stop and release the port.

From a source checkout, use `npm run dev -- <path-to-repo>` (no path reviews the
current repo).

## How it works

1. **Client** opens the review link, clicks elements, comments, and submits. Drafts
   persist in `localStorage` until submission, then are stored as JSON.
2. **Fix runs automatically.** Pin Point creates a worktree at the review's commit,
   runs Claude Code scoped to the feedback, runs the build gate, commits, pushes a
   `pinpoint/review-*` branch, and opens a draft PR.
3. **Developer** watches the dashboard: per-comment source mapping, a confidence
   badge (`direct` / `unresolved`), and live status
   (`preparing → running-agent → verifying → pushing → pr-opened`). Failed runs can
   be retried.
4. **Developer decides** on GitHub: merge, revise, or close the draft.

## Troubleshooting

- **"working tree must be clean"** — commit or stash changes before starting.
- **PR step fails** — check `gh auth status` and that the repo has a GitHub `origin`.
- **Agent step fails** — check the `claude` CLI is installed and authenticated. The
  job is marked `failed` with a sanitized reason; the worktree is kept and you can
  retry from the dashboard.

## Data and cleanup

State is JSON under `~/.pinpoint/data/` (`projects.json`, `reviews.json`,
`jobs.json`, redacted `logs/`) — one per-user store shared across runs. Preview
copies and worktrees live in the OS temp dir (`%TEMP%\pp\<hash>` on Windows).

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.pinpoint, $env:TEMP\pp -ErrorAction SilentlyContinue
```

`pinpoint kill` stops running sessions and clears their workspaces.