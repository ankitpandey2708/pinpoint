# Sharing previews over a public tunnel

Pinpoint serves a review preview locally (`http://localhost:7777/review/:projectId`)
and exposes it publicly through a Cloudflare **quick tunnel** so a reviewer can
open the link from anywhere. The tunnel is spawned in `src/platform/tunnel.ts`
as `cloudflared tunnel --url http://127.0.0.1:<port>`, which requires no account
and mints a throwaway `*.trycloudflare.com` hostname per run.

This note records a reliability issue seen over that tunnel, why the obvious fix
(a production build) is the wrong trade for Pinpoint, and the free tunnel options
if the quick tunnel proves too flaky.

## The issue: intermittent `ChunkLoadError` over the tunnel

Opening the **public** URL for some repos occasionally fails with a Next.js
`Runtime ChunkLoadError` — a `next/dynamic` chunk (e.g. a component's
`node_modules_*.js`) never loads, so hydration stalls and the page hangs. The
**local** URL always works.

Observed behaviour:

- One tunnel load left ~5 chunks stuck `[pending]` forever; a clean reload of the
  same session later returned **every** chunk `200` and rendered fully.
- It is **intermittent** — same code, same repo, different outcome per run — and
  only over the tunnel.

Root cause (best evidence, not a deterministic repro): Next **dev** fires ~60–130
concurrent chunk requests on first paint, and free `trycloudflare` **quick
tunnels** are known to stall/drop connections under that burst. Nothing in
Pinpoint's proxy drops the chunks — locally they always load. So this is a
tunnel-transport limitation, not a Pinpoint bug. A reload usually recovers it.

> Note: swapping the proxy library to `http-proxy-3` (done, to remove the
> `util._extend` `DEP0060` warning) is unrelated to this and did not change it.

## Why not "just serve a production build"

The tempting fix is to run the preview as `next build` + `next start` instead of
`next dev`: far fewer, content-hashed, precompiled chunks → no concurrent burst →
tunnel-friendly. **We deliberately do not do this**, because it breaks Pinpoint's
core mechanism:

- **Click-to-source dies.** The overlay uses `element-source` to map a clicked
  DOM node back to its source file / line / component. That relies on React's
  **dev-mode** fiber debug info, which a production build strips. See
  `src/preview/overlay/resolve.ts`: *"if element-source cannot resolve
  (non-framework element, production build), source/stack are null/empty."* The
  fix agent would fall back to text + CSS selector + HTML snippet only — much
  weaker grounding, worse auto-fixes. That is the whole value of the tool.
- **Slow startup.** A real `next build` per session is tens of seconds to
  minutes, versus dev's fast boot + lazy compile.
- **Build fragility.** `next build` runs full type-check/build-time validation
  and fails where `next dev` tolerates. (It must be invoked directly, not via the
  repo's own `build` script, which may have deploy side effects.)
- **Build-time env baking.** `NEXT_PUBLIC_*` is inlined at build time; the
  workspace has no `.env`, so a prod build bakes in undefined/fallbacks.

Verdict: **keep `next dev`.** Trading an intermittent, reload-able tunnel hiccup
for permanently losing precise click-to-source is a bad deal.

## Free tunnel options (if trycloudflare is too flaky)

What matters here: free, survives the concurrent-chunk burst, and low setup
friction (today's quick tunnel needs no account). No free tunnel is guaranteed
bulletproof under a ~100-way concurrent burst; the most stable free tiers are
account-backed persistent tunnels.

| Option | Free | Reliability under burst | Setup friction | Fit for Pinpoint |
|---|---|---|---|---|
| **Cloudflare *named* tunnel** | Yes, unlimited | Better than quick tunnels (persistent infra) | One-time: CF account + a domain on CF + `cloudflared login` | **Smallest code change — already spawns `cloudflared`.** Stable URL. |
| **Tailscale Funnel** | Yes (personal) | Very stable, fixed `*.ts.net` host | Tailscale account + daemon + enable Funnel | Most robust free option; solo-friendly. |
| **localhost.run** | Yes | Moderate (different infra) | None — one SSH command, no account | Closest to today's "just works"; good A/B against trycloudflare. |
| ngrok | Crippled since Feb 2026 | n/a | account + token | ❌ Avoid: 20k HTTP req/mo + 1 GB/mo + 3 endpoints; Next dev burns ~100 req/load, so a few reviews blow the cap. Free interstitial page. |
| bore | Yes (bore.pub) | TCP only | binary install | ❌ No HTTPS (client gets `http://bore.pub:PORT`); 10s unaccepted-connection discard can hurt under bursts. |
| localtunnel / serveo / pinggy | Yes | Flaky / session-capped | low | Skip: localtunnel unmaintained (2022) + password page; pinggy free caps sessions at 60 min. |

### Recommendation

- **Keep trycloudflare as the zero-setup default** — the issue is occasional and a
  reload works around it.
- **Offer an opt-in sturdier tunnel** for users who share review links often:
  - **Cloudflare named tunnel** — least new code (same `cloudflared`), stable URL.
  - **Tailscale Funnel** — most reliable free, fixed URL.
  - **localhost.run** — no-account fallback to A/B against trycloudflare.

### Implementation note

The tunnel command is currently hardcoded in `src/platform/tunnel.ts`
(`cloudflared tunnel --url …`). The clean enablement is to make the tunnel
**provider configurable** (env var / flag) with trycloudflare as the default, so
a named Cloudflare tunnel, Tailscale Funnel, or `localhost.run` can be selected
without code edits. Not yet implemented.

## References

- ngrok free plan limits — https://ngrok.com/docs/pricing-limits/free-plan-limits
- awesome-tunneling (alternatives list) — https://github.com/anderspitman/awesome-tunneling
- Tailscale — ngrok alternatives — https://tailscale.com/learn/ngrok-alternatives
- bore — https://github.com/ekzhang/bore
