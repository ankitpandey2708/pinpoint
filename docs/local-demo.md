# Local Demo Walkthrough

A step-by-step local run of Pin Point against its own repository. Everything here
is loopback-only and has no network side effects until you explicitly click
**Generate Fix PR** with `gh`/`claude` authenticated.

## 1. Install and verify

```powershell
npm install
npm run typecheck
npm test
npm run build
```

All three gates should pass.

## 2. Start Pin Point against this repo

The working tree must be clean (commit or stash local changes first).

```powershell
npm run dev -- review C:\Users\akp\Downloads\pinpoint
```

You'll see something like:

```text
  Pin Point is ready.

  Review link (send to your client): http://localhost:3000/review/<projectId>
  Developer dashboard:                http://localhost:3000/dashboard

  localhost is local-only. Use --host 0.0.0.0 for LAN, or a tunnel for remote clients.

  Press Ctrl+C to stop.
```

## 3. Act as the client

1. Open the **review link** in a browser.
2. Click two elements on the landing page (for example a heading and a button).
3. Type a comment for each (e.g. "Make this heading bigger").
4. **Refresh the page** — your draft comments are still there (localStorage draft
   recovery).
5. Enter a name and click **Submit feedback**.

## 4. Act as the developer

1. Open the **dashboard**.
2. Select the review. Each comment shows its source mapping back to `index.html`
   with a `direct` confidence badge and a source chip like `index.html:42`.
3. Click **Generate Fix PR**. Watch the job move through
   `preparing → running-agent → verifying → pushing → pr-opened`.
4. On success the dashboard shows a **draft pull request** link. Your local `main`
   is untouched; the change lives on a generated `pinpoint/review-*` branch.

## 5. Stop and clean up

Press **Ctrl+C** to stop the server (it shuts down the preview and releases the
port).

```powershell
Remove-Item -Recurse -Force data\*.json, data\logs, .pinpoint -ErrorAction SilentlyContinue
```

## Sharing modes at a glance

| Goal                  | Command / note                                                        |
| --------------------- | --------------------------------------------------------------------- |
| Just you (default)    | `npm run dev -- review <repo>` → `http://localhost:3000/...`          |
| Someone on your LAN   | add `--host 0.0.0.0`, share `http://<your-lan-ip>:3000/review/<id>`   |
| Remote / internet     | run a tunnel in front of the loopback server (expose review link only) |
| Proxy a deployed page | add `--url <public-url>` (source mapping is best-effort in this mode)  |

## Troubleshooting

- **"working tree must be clean"** — commit or stash changes before starting.
- **PR step fails** — ensure `gh auth status` is authenticated and the repo has a
  GitHub `origin` remote.
- **Agent step fails** — ensure the `claude` CLI is installed and authenticated.
  The job is marked `failed` with a sanitized reason and the worktree is kept for
  inspection; you can retry from the dashboard.
- **Port in use** — pass `--port <port>`.
