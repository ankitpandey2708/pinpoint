# Visual Feedback to Autonomous PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Pinpoint as a local-first visual review application that maps element-specific client feedback to source code, runs Claude Code in an isolated worktree, verifies the result, and opens a draft GitHub pull request.

**Architecture:** A TypeScript Node server owns project discovery, instrumented preview serving/proxying, JSON persistence, review APIs, dashboard APIs, job orchestration, Git worktrees, Claude Code execution, and GitHub draft-PR creation. Browser assets are framework-free JavaScript/CSS so they can be injected into arbitrary static or React/Next previews. Source instrumentation is adapter-based: parse5 for HTML and Babel AST plus MagicString for JSX/TSX.

**Tech Stack:** Node.js 24+, TypeScript, Commander, Express, http-proxy, parse5, @babel/parser, @babel/traverse, MagicString, Vitest, jsdom, Supertest, Git, GitHub CLI, Claude Code CLI.

## Global Constraints

- Work directly in `C:\Users\akp\Downloads\pinpoint` on `main`.
- Preserve the existing `index.html`, `README.md`, and all existing documentation.
- Do not modify or copy the ignored nested `toss/` repository; use it only as reference.
- Local storage is JSON with atomic replacement; no external database is required.
- Support plain HTML/CSS/JS and React/Next.js repositories in the first version.
- Client feedback contains only reviewer name and comments; repository/source metadata is attached automatically.
- A client submission must never run a coding agent directly.
- Only the developer dashboard may trigger “Generate Fix PR.”
- Agent edits happen only in an isolated Git worktree based on the review's recorded commit.
- Failed verification prevents push and PR creation.
- Pull requests are always drafts; never merge or force-push.
- Claude Code is the first runner, behind a replaceable interface.
- Preserve credentials on the server; never expose them to review clients or logs.
- Implementation may be committed and pushed directly to `origin/main` after the complete test suite passes.
- The live self-test targets Pinpoint itself and may create a generated `pinpoint/review-*` branch and draft PR.

---

## File Structure

```text
package.json                         Runtime/test scripts and dependencies
package-lock.json                    Reproducible dependency lock
 tsconfig.json                        TypeScript compiler settings
vitest.config.ts                     Node + jsdom test projects
src/index.ts                         CLI entry point
src/cli/review.ts                    `pinpoint review` command
src/domain/types.ts                  Project/review/annotation/job contracts
src/storage/json-store.ts            Atomic generic JSON persistence
src/storage/repositories.ts          Project/review/job repositories
src/repository/inspect.ts            Git/GitHub/framework/script discovery
src/instrumentation/types.ts         Instrumentation adapter contracts
src/instrumentation/html.ts          HTML IDs, manifest, overlay injection
src/instrumentation/jsx.ts           JSX/TSX IDs and source manifest
src/preview/workspace.ts             Temporary preview copies and cleanup
src/preview/runtime.ts               Static and framework preview processes
src/server/app.ts                    Express app and API composition
src/server/review-routes.ts          Review/static/proxy routes
src/server/api-routes.ts             Submission/dashboard/job APIs
src/server/proxy.ts                  React/Next reverse proxy and HTML injection
src/public/overlay.js                Client element picker and draft workflow
src/public/overlay.css               Isolated review UI styling
src/public/dashboard.html            Developer dashboard shell
src/public/dashboard.js              Review/job/PR dashboard behavior
src/public/dashboard.css             Dashboard styling
src/agents/types.ts                  Coding-agent interface
src/agents/claude.ts                 Claude Code noninteractive runner
src/agents/prompt.ts                 Feedback-to-agent task construction
src/git/worktree.ts                  Branch/worktree lifecycle
src/git/verify.ts                    Baseline and post-change checks
src/github/client.ts                 Push and draft PR through `gh`
src/jobs/orchestrator.ts             Review-to-worktree-to-PR state machine
src/lib/process.ts                   Spawn, timeout, cancellation, sanitized logs
src/lib/ids.ts                       Stable source IDs and entity IDs
tests/fixtures/static-site/          Static instrumentation fixture
tests/fixtures/react-site/           JSX instrumentation fixture
tests/unit/*.test.ts                 Focused unit tests
tests/integration/*.test.ts          HTTP/storage/git integration tests
tests/e2e/review-flow.test.ts        Browser-DOM review submission flow
data/.gitkeep                         Runtime data directory marker
docs/visual-feedback-to-autonomous-pr-flow.md  Product specification
README.md                            Install, run, architecture, safety, demo
```

---

### Task 1: Bootstrap the Parent TypeScript Application

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/domain/types.ts`
- Create: `src/lib/ids.ts`
- Create: `tests/unit/ids.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `Project`, `SourceMapping`, `AnnotationDraft`, `SubmittedReview`, `AgentJob`, and status union types.
- Produces `entityId(prefix): string` and `sourceId(relativeFile, line, column, tag): string`.

- [ ] **Step 1: Write failing ID tests**

Test that entity IDs are prefixed and unique, while source IDs are deterministic for the same source location and different for different locations.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/unit/ids.test.ts`
Expected: FAIL because the package and ID module do not exist.

- [ ] **Step 3: Add the minimal Node/TypeScript/Vitest package**

Scripts:

```json
{
  "dev": "tsx src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

Runtime dependencies: `@babel/parser`, `@babel/traverse`, `commander`, `express`, `http-proxy`, `magic-string`, and `parse5`.

Development dependencies: TypeScript, tsx, Vitest, jsdom, Supertest, and required `@types/*` packages.

- [ ] **Step 4: Define exact domain contracts**

At minimum:

```ts
export type Framework = 'static' | 'react' | 'next';
export type MappingConfidence = 'direct' | 'approximate' | 'unresolved';
export type JobStatus =
  | 'queued' | 'preparing' | 'running-agent' | 'verifying'
  | 'pushing' | 'pr-opened' | 'failed';

export interface SourceMapping {
  elementId: string;
  sourceFile?: string;
  component?: string;
  line?: number;
  column?: number;
  tag: string;
  confidence: MappingConfidence;
}
```

Complete the remaining project, annotation, review, verification, and job fields from the approved product specification.

- [ ] **Step 5: Implement IDs and verify GREEN**

Use `crypto.randomUUID()` for entities and SHA-256 over normalized source coordinates for stable source IDs.

Run: `npm test -- tests/unit/ids.test.ts`
Expected: PASS.

- [ ] **Step 6: Install dependencies and run baseline gates**

Run: `npm install && npm run typecheck && npm test`
Expected: all commands pass.

- [ ] **Step 7: Commit locally on main**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src tests .gitignore
git commit -m "feat: bootstrap pinpoint review application"
```

### Task 2: Atomic JSON Persistence

**Files:**
- Create: `src/storage/json-store.ts`
- Create: `src/storage/repositories.ts`
- Create: `tests/unit/json-store.test.ts`
- Create: `tests/unit/repositories.test.ts`
- Create: `data/.gitkeep`
- Modify: `.gitignore`

**Interfaces:**
- Produces `JsonStore<T extends { id: string }>` with `list`, `get`, `insert`, and `update`.
- Produces `Repositories` containing `projects`, `reviews`, and `jobs` stores.

- [ ] **Step 1: Write failing persistence tests**

Cover empty-file initialization, insert/read/update, duplicate ID rejection, missing record errors, concurrent serialized writes, and recovery when a write is interrupted before rename.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/json-store.test.ts tests/unit/repositories.test.ts`
Expected: FAIL because stores do not exist.

- [ ] **Step 3: Implement atomic JSON writes**

Write formatted JSON to `<file>.tmp-<pid>-<uuid>`, fsync/close it, then rename over the destination. Serialize mutations through an in-process promise queue. Never log record contents.

- [ ] **Step 4: Configure runtime paths**

Track `data/.gitkeep`; ignore `data/*.json`, `data/logs/`, `.pinpoint/`, and temporary preview/worktree directories.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/unit/json-store.test.ts tests/unit/repositories.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit locally**

```bash
git add src/storage tests/unit data/.gitkeep .gitignore
git commit -m "feat: add atomic JSON review storage"
```

### Task 3: Repository and Framework Inspection

**Files:**
- Create: `src/lib/process.ts`
- Create: `src/repository/inspect.ts`
- Create: `tests/unit/process.test.ts`
- Create: `tests/integration/repository-inspect.test.ts`

**Interfaces:**
- Produces `runProcess(command, args, options): Promise<ProcessResult>` with timeout, abort signal, output cap, and secret redaction.
- Produces `inspectRepository(path): Promise<RepositoryInfo>`.

- [ ] **Step 1: Write failing process and inspection tests**

Use temporary Git repositories. Cover clean/dirty state, missing GitHub remote, GitHub HTTPS/SSH URL normalization, branch/commit capture, static detection, React detection, Next detection, and script discovery.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/process.test.ts tests/integration/repository-inspect.test.ts`
Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement safe process execution**

Use `spawn` with argument arrays, never shell interpolation. Cap captured output, enforce timeout, terminate child process trees on Windows, and redact common token/password patterns before persistence.

- [ ] **Step 4: Implement repository inspection**

Run exact Git commands in the target directory:

```text
git rev-parse --show-toplevel
git status --porcelain
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git remote get-url origin
```

Reject dirty repositories. Normalize GitHub remotes to `owner/repo`. Read `package.json` without executing it. Detect Next before React; otherwise use static when an HTML entry exists.

- [ ] **Step 5: Detect verification and preview commands**

Prefer declared package scripts in this order:
- test: `npm test -- --runInBand` only when compatible; otherwise `npm test`;
- lint: `npm run lint`;
- typecheck: `npm run typecheck`;
- build: `npm run build`;
- Next preview: `npm run dev -- --hostname 127.0.0.1 --port <port>`;
- React/Vite preview: `npm run dev -- --host 127.0.0.1 --port <port>`;
- static preview: Pinpoint serves files itself.

Store argument arrays rather than shell strings.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- tests/unit/process.test.ts tests/integration/repository-inspect.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: inspect review repositories safely`.

### Task 4: HTML Source Instrumentation

**Files:**
- Create: `src/instrumentation/types.ts`
- Create: `src/instrumentation/html.ts`
- Create: `tests/fixtures/static-site/index.html`
- Create: `tests/fixtures/static-site/styles.css`
- Create: `tests/unit/html-instrumentation.test.ts`

**Interfaces:**
- Produces `InstrumentationResult { content, mappings }`.
- Produces `instrumentHtml(html, relativeFile, overlayUrls): InstrumentationResult`.

- [ ] **Step 1: Write failing HTML instrumentation tests**

Cover stable `data-pinpoint-id` attributes, source file and line mapping, excluded tags (`html`, `head`, `meta`, `script`, `style`, overlay UI), preservation of attributes/content, and exactly one injected CSS/script reference before `</head>`/`</body>`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/html-instrumentation.test.ts`
Expected: FAIL because instrumentation does not exist.

- [ ] **Step 3: Implement parse5-based instrumentation**

Use parse5 source locations. Assign IDs only to visible/body elements with valid opening tags. Mark generated overlay nodes with `data-pinpoint-ui` so the picker ignores itself.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/unit/html-instrumentation.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: map HTML elements to source locations`.

### Task 5: JSX/TSX Source Instrumentation

**Files:**
- Create: `src/instrumentation/jsx.ts`
- Create: `tests/fixtures/react-site/src/Hero.tsx`
- Create: `tests/fixtures/react-site/src/CardList.tsx`
- Create: `tests/unit/jsx-instrumentation.test.ts`

**Interfaces:**
- Produces `instrumentJsx(source, relativeFile): InstrumentationResult`.

- [ ] **Step 1: Write failing JSX/TSX tests**

Cover lowercase host elements, fragments, custom components, TypeScript syntax, existing spread props, nested components, deterministic IDs, nearest component/function naming, and repeated elements created by `.map()`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/unit/jsx-instrumentation.test.ts`
Expected: FAIL because JSX instrumentation does not exist.

- [ ] **Step 3: Implement AST-safe insertion**

Parse with Babel TypeScript/JSX plugins. Traverse `JSXOpeningElement` nodes. Instrument only lowercase DOM host tags. Use MagicString to insert ` data-pinpoint-id="..."` after the tag name without reformatting the rest of the source. Derive the nearest function, class, or variable component name when possible.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- tests/unit/jsx-instrumentation.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: map React elements to source components`.

### Task 6: Temporary Preview Workspaces and Runtime

**Files:**
- Create: `src/preview/workspace.ts`
- Create: `src/preview/runtime.ts`
- Create: `tests/integration/preview-workspace.test.ts`
- Create: `tests/integration/static-preview.test.ts`

**Interfaces:**
- Produces `createPreviewWorkspace(project): Promise<PreviewWorkspace>`.
- Produces `startPreview(workspace): Promise<PreviewRuntime>` with URL, stop, mappings, and logs.

- [ ] **Step 1: Write failing workspace/runtime tests**

Assert the original repository remains byte-identical, ignored directories are excluded, static HTML is instrumented, assets remain available, mappings are emitted, and cleanup removes only Pinpoint-owned temporary directories.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/integration/preview-workspace.test.ts tests/integration/static-preview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement safe temporary copies**

Create `.pinpoint/previews/<project-id>` under the Pinpoint data root. Copy files while excluding `.git`, `node_modules`, `.next`, `dist`, `build`, `coverage`, `data`, and `.pinpoint`. Instrument HTML or JSX/TSX in the copy only and write a private manifest outside the served root.

- [ ] **Step 4: Implement runtimes**

Static mode serves the temporary root directly. React/Next mode installs dependencies with the lockfile-appropriate command, starts the detected dev server on a loopback-only ephemeral port, waits for readiness, and captures sanitized logs. Track child processes for reliable shutdown.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- tests/integration/preview-workspace.test.ts tests/integration/static-preview.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: create isolated instrumented previews`.

### Task 7: Review Overlay and Submission API

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/review-routes.ts`
- Create: `src/server/api-routes.ts`
- Create: `src/server/proxy.ts`
- Create: `src/public/overlay.js`
- Create: `src/public/overlay.css`
- Create: `tests/integration/review-api.test.ts`
- Create: `tests/e2e/review-flow.test.ts`

**Interfaces:**
- Produces review URL `/review/:projectId/*`.
- Produces `POST /api/projects/:projectId/reviews`.
- Submission body contains only `reviewerName` and client-captured annotations; the server resolves source mappings.

- [ ] **Step 1: Write failing API tests**

Cover valid grouped submission, empty reviewer rejection, empty comments rejection, unknown project/element rejection, stripping client-supplied repository/source fields, server-side enrichment, and one immutable submitted review record.

- [ ] **Step 2: Write failing jsdom overlay test**

Simulate hovering, selecting two elements, adding/editing/deleting comments, localStorage draft recovery, reviewer-name validation, final submission, and clearing the draft only after a successful response.

- [ ] **Step 3: Verify RED**

Run: `npm test -- tests/integration/review-api.test.ts tests/e2e/review-flow.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement isolated overlay UI**

Use a Shadow DOM root marked `data-pinpoint-ui`. Ignore Pinpoint UI, `html`, `body`, scripts, styles, and non-visible elements. Draw hover/selected outlines in a fixed top layer. Capture route, selector, tag, classes, visible text, nearby text, and element ID. Store drafts under a key scoped to project ID and recorded commit.

- [ ] **Step 5: Implement secure submission**

Validate size/count limits. Resolve element IDs through the private manifest. Ignore any technical fields supplied by the client. Save the enriched review through the repository interface.

- [ ] **Step 6: Implement static serving and framework proxying**

For static previews, serve instrumented files. For React/Next previews, proxy all methods and WebSocket upgrades to the internal loopback server; inject overlay references into HTML responses only. Never proxy Pinpoint API/dashboard routes.

- [ ] **Step 7: Verify GREEN and commit**

Run: `npm test -- tests/integration/review-api.test.ts tests/e2e/review-flow.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: collect element-specific client feedback`.

### Task 8: Developer Dashboard

**Files:**
- Create: `src/public/dashboard.html`
- Create: `src/public/dashboard.js`
- Create: `src/public/dashboard.css`
- Modify: `src/server/api-routes.ts`
- Create: `tests/integration/dashboard-api.test.ts`

**Interfaces:**
- Produces `GET /api/projects`, `GET /api/reviews`, `GET /api/reviews/:id`, `GET /api/jobs/:id`, and `POST /api/reviews/:id/jobs`.

- [ ] **Step 1: Write failing dashboard API tests**

Cover review summaries, annotation mappings/confidence, job status, duplicate-job prevention, and refusal to start jobs for unresolved/missing reviews.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/integration/dashboard-api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement dashboard UI**

Preserve the visual direction of the existing Pin Point landing page and Toss comment widget: purple accent, clear numbered pins, compact source chips, review/job status cards, readable logs, and explicit destructive/action states. Include review list, annotation detail, mapping confidence, Generate Fix PR button, job progress, failure reason, and PR link.

- [ ] **Step 4: Protect job initiation**

Bind the dashboard/API to loopback by default. Require a per-server developer session token for mutation routes; embed it only in the locally served dashboard, never in review pages.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- tests/integration/dashboard-api.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: add developer review dashboard`.

### Task 9: Claude Code Runner and Prompt

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/prompt.ts`
- Create: `src/agents/claude.ts`
- Create: `tests/unit/agent-prompt.test.ts`
- Create: `tests/integration/claude-runner.test.ts`

**Interfaces:**
- Produces `CodingAgent.run(task, options): Promise<AgentResult>`.
- Claude implementation runs in the supplied worktree only.

- [ ] **Step 1: Write failing prompt tests**

Ensure grouped feedback includes repository-relative sources, client comments, selector/text context, base commit, scope restrictions, verification expectations, and explicit prohibitions on commit/push/PR operations.

- [ ] **Step 2: Write a fake-CLI runner test**

Use a temporary executable to assert exact argument-array invocation, worktree cwd, timeout handling, cancellation, nonzero exit handling, and sanitized stream-json logging.

- [ ] **Step 3: Verify RED**

Run: `npm test -- tests/unit/agent-prompt.test.ts tests/integration/claude-runner.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement Claude invocation**

Use installed real flags:

```text
claude -p <prompt>
  --output-format stream-json
  --permission-mode acceptEdits
  --allowedTools Read Glob Grep Edit Write "Bash(npm *)" "Bash(npx *)"
```

Disallow Git network/history mutation tools in the agent prompt and allowlist. Pinpoint—not Claude—owns commit, push, and PR operations. Capture structured progress while redacting secrets.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- tests/unit/agent-prompt.test.ts tests/integration/claude-runner.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: run feedback fixes through Claude Code`.

### Task 10: Worktree, Verification, and GitHub Draft PR

**Files:**
- Create: `src/git/worktree.ts`
- Create: `src/git/verify.ts`
- Create: `src/github/client.ts`
- Create: `tests/integration/worktree.test.ts`
- Create: `tests/integration/verify.test.ts`
- Create: `tests/integration/github-client.test.ts`

**Interfaces:**
- Produces worktree create/inspect/commit/cleanup operations.
- Produces `verifyRepository(info, worktree): Promise<VerificationResult>`.
- Produces `createDraftPullRequest(input): Promise<{ url: string; number: number }>`.

- [ ] **Step 1: Write failing worktree tests**

Cover creation from an exact base commit, generated branch naming, original-tree isolation, changed-file detection, commit creation, no-change refusal, and cleanup without deleting a worktree on failure.

- [ ] **Step 2: Write failing verification tests**

Use fixture scripts for pass, fail, timeout, and missing scripts. Record command, exit code, duration, and sanitized output. Require every available configured gate to pass.

- [ ] **Step 3: Write failing GitHub client tests**

Use fake `git`/`gh` executables. Assert argument arrays for push and `gh pr create --draft`, PR body contents, URL parsing, and failure propagation. Assert no force-push flag can appear.

- [ ] **Step 4: Verify RED**

Run: `npm test -- tests/integration/worktree.test.ts tests/integration/verify.test.ts tests/integration/github-client.test.ts`
Expected: FAIL.

- [ ] **Step 5: Implement worktree and verification**

Use `git worktree add -b <branch> <path> <baseCommit>`. Refuse existing branch/path collisions. Keep failed worktrees for inspection; clean successful ones only after PR metadata is persisted.

- [ ] **Step 6: Implement GitHub operations**

Use the authenticated `gh` CLI. Push with `git push -u origin <generated-branch>`. Open with `gh pr create --draft --base <baseBranch> --head <branch> --title ... --body-file ...`. Parse JSON or URL output without scraping unrelated text.

- [ ] **Step 7: Verify GREEN and commit**

Run focused tests plus typecheck.
Expected: PASS.

Commit: `feat: verify changes and open draft pull requests`.

### Task 11: Job Orchestration and CLI

**Files:**
- Create: `src/jobs/orchestrator.ts`
- Create: `src/cli/review.ts`
- Create: `src/index.ts`
- Modify: `src/server/api-routes.ts`
- Create: `tests/integration/job-orchestrator.test.ts`
- Create: `tests/integration/cli.test.ts`

**Interfaces:**
- Produces the complete persisted job state machine.
- Produces `pinpoint review <repo> [--url <public-url>] [--port <port>] [--host <host>]`.

- [ ] **Step 1: Write failing orchestrator tests**

Inject fake agent, Git, verifier, and GitHub adapters. Assert exact transitions, one active job per review, failure at every stage, retry eligibility, no push before verification, and persisted PR URL on success.

- [ ] **Step 2: Write failing CLI tests**

Cover help, missing path, dirty repository, project creation, printed dashboard/review URLs, Ctrl+C shutdown, loopback default, explicit LAN host, and remote URL requiring a local repository.

- [ ] **Step 3: Verify RED**

Run: `npm test -- tests/integration/job-orchestrator.test.ts tests/integration/cli.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement state machine**

Transitions:

```text
queued → preparing → running-agent → verifying → pushing → pr-opened
                                                    ↘ failed
```

Persist before and after every external operation. On restart, mark interrupted nonterminal jobs failed with a recoverable reason rather than silently rerunning them.

- [ ] **Step 5: Implement CLI composition**

Inspect repository, create project record, create/start preview, start Express, print review/dashboard URLs, and close proxy/process/temp resources on SIGINT/SIGTERM.

- [ ] **Step 6: Verify GREEN and commit**

Run focused tests, full tests, and typecheck.
Expected: PASS.

Commit: `feat: orchestrate reviews from CLI to draft PR`.

### Task 12: Documentation, Full Verification, Push Main, and Live Self-Test

**Files:**
- Modify: `README.md`
- Modify: `docs/visual-feedback-to-autonomous-pr-flow.md`
- Create: `docs/local-demo.md`
- Create or modify: tests needed by defects found during verification

**Interfaces:**
- Documents install, prerequisites, local review, LAN/tunnel distinction, dashboard, Claude/GitHub authentication, JSON data, troubleshooting, and cleanup.

- [ ] **Step 1: Update user documentation**

Document copy-pasteable Windows PowerShell commands:

```powershell
npm install
npm test
npm run build
npm run dev -- review C:\Users\akp\Downloads\pinpoint
```

Explain that `localhost` is local-only, LAN sharing requires `--host 0.0.0.0`, and remote clients require a tunnel or future hosted deployment.

- [ ] **Step 2: Run all automated gates**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all pass with no unhandled warnings or open handles.

- [ ] **Step 3: Run local browser smoke test**

Start Pinpoint against its own repository. Open the review URL, annotate at least two elements in the existing `index.html`, refresh to verify draft recovery, submit with a test reviewer name, and verify the dashboard shows direct mappings to `index.html`.

- [ ] **Step 4: Verify job behavior without network side effects**

Run the submitted review through the orchestrator with fake Claude/GitHub adapters. Confirm the original working tree remains unchanged and the job reaches `pr-opened` with a fixture URL.

- [ ] **Step 5: Commit final implementation on main**

Review `git diff`, ensure no runtime JSON/logs/secrets are tracked, then commit remaining documentation and fixes with a conventional commit.

- [ ] **Step 6: Push completed implementation directly to main**

The user explicitly authorized:

```bash
git push origin main
```

Verify local `main` equals `origin/main` after push.

- [ ] **Step 7: Run the authorized live self-test**

Start Pinpoint using the now-clean, pushed Pinpoint repository. Submit a harmless, explicit visual change request against `index.html`. From the dashboard, click Generate Fix PR. Verify:

- Claude works in a generated worktree;
- original `main` remains unchanged;
- tests/build pass;
- generated branch is pushed;
- a draft PR targets `main`;
- dashboard records the real PR URL;
- no merge occurs.

- [ ] **Step 8: Report exact evidence**

Report test/build commands and results, pushed main commit, review ID, generated branch, draft PR URL, and any retained failed-worktree/log paths. Do not report success without reading back GitHub PR state through `gh pr view`.
