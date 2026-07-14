# In-Memory Source Mapping — replacing the preview worktree

Research + spike notes for moving Pinpoint's click-to-source mapping from
**file rewriting inside a git worktree** to **runtime resolution in the running
app** (the "memory approach"). Captures why, the options, a validated spike, the
deficiencies found, how to enhance them, and exactly what we reuse from
`element-source` / `react-grab`.

_Date: 2026-07-14. Stack under test: `dhbvn-web` — Next.js 16.2.4 (Turbopack),
React 19.2.5._

---

## 1. Why the worktree exists today (and its cost)

To let a client click a rendered element and have us resolve the exact **source
file + line**, Pinpoint injects `data-pinpoint-id` markers into the HTML/JSX.
Injecting markers **modifies files**, and the user's real repo must stay
pristine — so we work on a **throwaway copy** (a detached `git worktree`), boot
the framework's dev server against it, and serve that.

Cost of the copy path (measured):

| Phase | Time (dhbvn-web) |
|---|---|
| `inspect` | ~0.3s |
| `workspace` (worktree + hardlink `node_modules` + instrument) | ~8s (was 24s before batch tuning) |
| `preview` (dev-server boot + readiness) | ~7.5s |
| **total to serveable URLs** | ~16s |

The `workspace` cost is inherent to materializing a per-run copy (32k+
`node_modules` entries hardlinked every start).

## 2. The "memory approach"

Run the repo's **own dev server in place** (no copy, no worktree, no
`node_modules` hardlink) — Pinpoint just proxies it, as it already does for
framework previews. Inject a small overlay that, on click, resolves the DOM node
to its source **at runtime** from the framework's live dev internals. Result:
startup collapses to just the framework's own dev boot, and the target repo
needs **zero changes**.

## 3. Research findings

| Finding | Implication |
|---|---|
| **React 19 removed `_debugSource`** from fibers ([#32574](https://github.com/facebook/react/issues/32574)) | The naive "read source off the fiber" is broken on modern React; no official replacement. |
| **Turbopack (Next 16 default) is SWC-only — no Babel** ([docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack)) | Compile-time Babel attribute injection is out for Next by default. |
| **Turbopack *does* run webpack loaders** via `turbopack.rules` (auto-configures `babel-loader` if a Babel config exists) | Exact per-element injection is still possible under Turbopack — via a loader rule (opt-in). |
| **`element-source`** — runtime lib, resolves any DOM node → source across React/Preact/Vue/Svelte/Solid ([repo](https://github.com/aidenybai/element-source)) | The reusable core; no bundler plugin required. |
| **`react-grab`** — MIT tool built *on* element-source; turns a browser selection into agent-ready source context ([repo](https://github.com/aidenybai/react-grab)) | Same problem domain; the UX/payload layer to borrow from. |
| **`react-dev-inspector`** — compile-time loader injecting `data-*` source attrs + dev-server middleware ([repo](https://github.com/zthxxx/react-dev-inspector)) | Reference for the opt-in exact-precision loader. |

## 4. Spike — validated

Headless Chrome (puppeteer-core) against the live `dhbvn-web` dev server,
`element-source` bundled and run in-page:

```
h1  "Faridabad Power Outages — Live"  → components/DistrictPage.tsx:53   (DistrictPage)
button/span "Faridabad"               → components/MobileStatusBar.tsx:25 (MobileStatusBar)
```

No page errors. **Confirmed: the memory approach works on the worst-case stack
(React 19 + Turbopack), zero build config, no worktree.**

## 5. Deficiencies found in the spike

1. **Component-level precision, not exact element.** Every element inside a
   component resolved to the *same* line (the component's), and `columnNumber`
   was `null`. Because React 19 dropped `_debugSource` and Turbopack can't run
   the Babel JSX-source transform, element-source falls back to **owner stacks**
   — which component rendered the element, not the precise JSX line/col. This is
   a downgrade from the current per-element `data-pinpoint-id` precision.
2. **Inconsistent path formats.** Some paths came back relative
   (`components\DistrictPage.tsx`), some as source-map-style absolute
   (`/Users/akp/Downloads/dhbvn-web/components/MobileStatusBar.tsx`). Need
   normalization to repo-relative.

## 6. How to enhance the deficiencies

### Deficiency 1 — precision
- **(A) Enrich the payload (zero-config, recommended primary).** This is
  react-grab's proven trick: send `componentName` + `file:line` + **full
  `resolveStack` hierarchy** + the clicked element's **`outerHTML` snippet +
  visible text + tag + unique CSS selector**. react-grab ships exactly this
  (*"a pointer like `header-actions.tsx:line 42` plus a snippet of the JSX that
  rendered exactly what you clicked"*) and reports agents are **2× faster /
  surgical**. The fix agent already greps — component file + rendered snippet +
  text lands it on the right element.
- **(B) Exact line/col (opt-in per-repo config).** A compile-time loader that
  injects `data-pinpoint-loc="file:line:col"`:
  - **Next/Turbopack:** `turbopack.rules` loader (babel-loader w/
    `@babel/plugin-transform-react-jsx-source`, or react-dev-inspector's loader).
  - **Vite:** a plugin.
  - **webpack (CRA):** a loader.
  Overlay prefers `data-pinpoint-loc` when present, falls back to element-source.
  Cost: a per-repo config line + build overhead → keep opt-in.

### Deficiency 2 — path normalization
Server-side normalizer: strip source-map roots (`/Users/akp/…` → repo-relative),
`\`→`/`, resolve against the repo, and **validate the path is a tracked file**
(`git ls-files`). This doubles as the security check for client-reported paths
(resolution moved client-side; external reviewers are untrusted).

## 7. MECE — what we reuse

Two mutually-exclusive layers; together they cover everything worth taking.

### From `element-source` — depend on / bundle (resolution engine)
| # | Thing | API |
|---|---|---|
| 1 | DOM node → source location (file, line, col, component) | `resolveElementInfo` / `resolveSource` |
| 2 | Full component stack (hierarchy) | `resolveStack` |
| 3 | Nearest component name | `resolveComponentName` |
| 4 | Cross-framework adapters (React, Preact, Vue, Svelte, Solid) | `createSourceResolver`, `vueResolver`, `svelteResolver` |
| 5 | Tag extraction + stack formatting | `getTagName`, `formatStack`, `formatStackFrame` |

### From `react-grab` — copy patterns/ideas (MIT; layer above)
| # | Thing | Why |
|---|---|---|
| 6 | Enriched payload shape (selection + stack + HTML/JSX snippet) | Makes component-level "good enough" |
| 7 | Overlay/selection UX (hover-highlight, click-select, toolbar) | Interaction patterns |
| 8 | Injection model (one global script into the running app) | Validates "bundle overlay + element-source, inject via proxy" |
| 9 | Project-root path anchoring (its CLI runs "at project root") | The normalization pattern |

**Deliberately not taken:** clipboard/manual-paste handoff, plugin marketplace,
install-in-your-app + dev-only + trusted-local assumptions, React-centric
framing. react-grab is a *developer dev-time clipboard helper*; Pinpoint is a
*client-facing autonomous review→PR pipeline*. Shared sensor, different nervous
system.

## 8. Who covers the deficiencies

| Deficiency | element-source | react-grab | Residual on us |
|---|---|---|---|
| **Component-level precision** | ❌ (this is its ceiling; provides `resolveStack` only) | ⚠️ Mitigates via enriched payload; can't give exact line either | Exact line/col → opt-in compile-time loader (ours) |
| **Path inconsistency** | ❌ (it's the *cause* — mixed rel/abs) | ✅ Pattern-wise (project-root anchoring) | Server-side validation that path is a tracked file (ours) |

**Bottom line:** react-grab conceptually covers *both* (payload → precision,
project-root → paths); element-source covers *neither* (it's the raw engine that
exhibits both). Residual work is small: opt-in exact-line loaders + server-side
path validation.

## 9. Recommended architecture

- **Default:** in-place dev server + `element-source` + **enriched payload (6A)**
  + **path normalization (§6.2)**. No worktree, no per-repo config; works across
  React/Vue/Svelte/Solid. The react-grab-proven path.
- **Static HTML:** no framework runtime, so keep injecting markers — but
  **in-memory at serve time** (we already read+inject per request in
  `routes.ts`), so this path drops the worktree too.
- **Opt-in:** the loader configs (6B) per framework — the "config for top
  frameworks" deliverable — for teams that want exact line/column.

Net: the worktree, the copy, the hardlink, and the startup sweep all go away;
startup becomes just the framework's own dev boot.

### Decisions still open
1. Accept component-level precision as the default (recommended) vs. require
   exact line/col (forces the opt-in loaders up front)?
2. Add `element-source` as a runtime dependency (young library, reputable author).
3. Security: server-side validation of client-reported source paths.

## 10. Sources
- element-source — https://github.com/aidenybai/element-source
- react-grab — https://github.com/aidenybai/react-grab
- react-dev-inspector — https://github.com/zthxxx/react-dev-inspector
- React 19 `_debugSource` removal — https://github.com/facebook/react/issues/32574
- Turbopack config (loaders, SWC-only) — https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack
- vite-plugin-vue-inspector — https://github.com/webfansplz/vite-plugin-vue-inspector
- unplugin — https://github.com/unjs/unplugin
