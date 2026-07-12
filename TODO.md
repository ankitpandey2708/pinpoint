# TODO — deferred work

Items intentionally left out of the first version. Each notes why it was deferred
and what implementing it would involve.

## Remote Public URL Mode (`--url`)

**Status:** deferred (a `--url` option existed briefly, then was removed rather
than shipped half-working).

**What it is:** a second preview mode alongside the supported repository-build
mode. Instead of serving the locally-built site, the tool proxies an
already-deployed public page (e.g. `https://example.com`) to the client while
still receiving the corresponding local repository for source mapping.

```
pinpoint review C:\path\to\repo --url https://example.com
```

**Why it's harder:** a deployed page has no build-time source metadata (no
`data-pinpoint-id` labels, which only exist when the tool instruments and builds
the source itself). So clicked elements can't be mapped to a source file
directly — mapping becomes **best effort**, inferred from:

- visible text;
- IDs and class names;
- DOM selector;
- route;
- nearby content;
- repository search;
- coding-agent reasoning.

Authenticated apps and sites that block proxying are outside the reliable
support boundary for this mode.

**What already exists (plumbing):**

- HTTP/WebSocket reverse proxy with overlay injection — `src/server/proxy.ts`
  (`proxyRequest`, `handleUpgrade`) and `injectFullOverlay` in
  `src/server/inject.ts`. Framework previews already run through this path
  against a loopback dev server.
- A `PreviewSession` carries a `proxyUrl` target — `src/server/preview-registry.ts`.

**What implementing it needs:**

1. Re-add the `--url <public-url>` CLI option and thread it through
   `startReview` in `src/cli/review.ts` (previously stored as `project.publicUrl`).
2. In `src/preview/runtime.ts`, when a public URL is supplied, return a `proxy`
   runtime whose `url` targets that public origin instead of spawning a local
   dev server.
3. An **approximate source resolver**: map a submitted client annotation
   (selector / visible text / classes / route) to a candidate source file in the
   local repo, tagging the mapping `approximate` or `unresolved`. This is the
   real work — the submit path in `src/server/api-routes.ts` currently requires a
   known `elementId` from the instrumented manifest, which proxied pages won't
   have.
4. Dashboard already renders `approximate` / `unresolved` confidence badges, so
   no UI change is required there.

**Reference:** the spec's "Preview Mode" section
(`docs/visual-feedback-to-autonomous-pr-flow.md`) notes this deferral.
