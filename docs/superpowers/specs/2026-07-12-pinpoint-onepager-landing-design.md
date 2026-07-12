# Pin Point — One-Pager & Landing Page Design

## Purpose
Produce two content deliverables to validate the Pin Point idea with early users (clients and freelancers). No product, no working app — just the pitch, in a form that can be shared for feedback and email signups.

## Product concept
Pin Point is a visual feedback tool: clients/internal teams leave in-context, pinned comments directly on a freelancer's landing page instead of vague feedback over email/Slack/screenshots. An AI agent categorizes each comment as low/mid/high effort. For low-effort items, the agent drafts a PR that a human reviews before merging — closing the loop from "here's what's wrong" faster than manual triage.

Framing: two-sided tool, shared by the client giving feedback and the freelancer receiving it. Neither side is favored.

Primary pain point to lead with: feedback today is disconnected from the page itself (email, Slack, screenshots) — Pin Point makes it pinned and contextual.

AI triage / auto-PR is a secondary highlight, not the hero pitch.

## Deliverable 1: One-pager (`onepager.md`)
Format: Markdown, single scannable doc.

Sections:
1. Headline + one-line pitch
2. The problem — feedback is disconnected from the page; even clear feedback still costs a freelancer time to action
3. How it works (3 steps): pin a comment on the live page → AI categorizes effort → low-effort items become a PR for human review
4. Who it's for — clients & freelancers, side by side
5. Why now / why it matters — short close, no fundraising language; written for someone deciding "would I use this"

## Deliverable 2: Landing page (`landing.html`)
Format: single self-contained HTML file (inline CSS, no build step, no backend) — opens directly in a browser or deploys as a static file anywhere.

Style: clean/minimal SaaS — generous whitespace, one accent color, sans-serif type (Linear/Vercel-style).

Sections:
1. Hero — headline + subhead around "pin feedback directly on the page"; primary CTA is a waitlist email input (front-end only, no real backend)
2. Problem framing — 2-3 short lines/cards on feedback being disconnected from the page
3. How it works — 3-step visual: pin comment → AI triage tags low/mid/high → auto-PR for low-effort, human-reviewed
4. Two audiences — split panel: "For clients" / "For freelancers," each with a couple of value bullets
5. Waitlist CTA (footer) — styled email form, no backend wiring

Explicitly out of scope: pricing, login/auth, real product screenshots (none exist yet — use a stylized CSS/SVG comment-pin illustration instead), any backend/email-capture wiring.

## Purpose of this round
Idea validation — page is meant to be shared to gauge interest and collect emails (form is visual-only for now, not wired to a backend).
