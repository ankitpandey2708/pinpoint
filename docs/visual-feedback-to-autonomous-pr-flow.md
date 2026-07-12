# Visual Feedback to Autonomous Pull Request Flow

## Product Goal

This tool helps a developer collect visual feedback on a landing page and turn that feedback into a draft GitHub pull request.

The client does not need technical knowledge. They only open a review link, click page elements, write comments, enter their name, and submit.

The system handles the technical work behind the scenes:

- connecting feedback to the correct repository and Git version;
- mapping clicked page elements to likely source files and components;
- asking a coding agent to implement the feedback;
- running the repository's tests and build;
- creating a draft GitHub pull request for the developer to review.

The system never automatically merges a pull request.

## Simple End-to-End Flow

```text
Developer provides GitHub repository
        ↓
Tool creates an instrumented preview
        ↓
Developer sends review URL to client
        ↓
Client clicks elements and writes comments
        ↓
Client submits the complete review
        ↓
Developer inspects feedback in a dashboard
        ↓
Developer clicks “Generate Fix PR”
        ↓
Coding agent edits an isolated Git worktree
        ↓
Tests and build run
        ↓
Draft GitHub pull request is created
        ↓
Developer reviews and decides whether to merge
```

## 1. Developer Starts a Review

The developer gives the tool a local Git repository:

```text
pinpoint review C:\projects\client-website
```

The first version supports:

- plain HTML, CSS, and JavaScript repositories;
- React repositories;
- Next.js repositories.

The tool checks that:

- the path is a Git repository;
- the working tree is clean;
- the repository has a GitHub remote;
- GitHub CLI authentication is available;
- the project type is supported;
- the project can be built or served.

The tool privately records:

- the GitHub repository;
- the current branch;
- the current commit;
- the detected framework;
- the commands needed to build, test, and preview the project.

## 2. Tool Creates a Review URL

The tool starts an instrumented preview and returns a URL such as:

```text
http://localhost:3000/review/abc123
```

When the application is hosted later, the same kind of review could be available at:

```text
https://pinpoint.app/review/abc123
```

The developer sends this URL to the client. The client does not install a browser extension or provide GitHub information.

## 3. Tool Adds Invisible Element Labels

Before showing the page, the tool adds hidden review identifiers to selectable elements.

Conceptually:

```text
Pricing heading → element-42
Signup button   → element-51
Hero image      → element-63
```

The client cannot see these identifiers.

For a plain HTML project, the tool maps each identifier to its HTML file and element context:

```text
element-42 → index.html → pricing heading
```

For React and Next.js projects, the tool instruments JSX and TSX files in a temporary preview copy:

```text
element-42 → src/components/PricingSection.tsx → PricingSection
```

The original repository is not modified during preview instrumentation.

A CSS selector alone cannot reliably identify a source file. Therefore, each annotation combines multiple signals:

- hidden review identifier;
- source file and component when available;
- page route;
- DOM selector;
- element tag and classes;
- visible text;
- nearby text and parent context.

## 4. Client Adds Visual Feedback

The client opens the review URL and sees the landing page with a review toolbar.

They can:

- hover over visible elements;
- click an element to select it;
- enter a comment;
- see a visual pin or highlight;
- edit an existing comment;
- delete a comment;
- continue reviewing other elements.

Example comments:

```text
Pricing heading:
“Make this heading bigger.”

Signup button:
“Change this text to Start Free Trial.”
```

The client only provides normal, nontechnical feedback.

## 5. Feedback Remains a Browser Draft

Adding a comment does not immediately send it to the server.

The browser keeps the annotations as a draft until the client submits the complete review. Drafts should survive page refreshes by using browser storage.

Before submitting, the client can review, edit, or delete their annotations.

## 6. Client Submits the Review

The client enters their name and clicks **Submit Feedback**.

The client provides only:

- their name;
- their comments;
- the elements they selected through the visual interface.

The server automatically enriches the submission with technical metadata already associated with the review:

- GitHub repository;
- base branch;
- base commit;
- page route;
- element identifier;
- source file and component when known;
- selector and visible element context;
- source-mapping confidence.

The submitted review is stored in a local JSON data store for the first version.

## 7. Developer Reviews the Feedback

The developer opens a local dashboard:

```text
http://localhost:3000/dashboard
```

The dashboard shows submitted reviews and their annotations:

```text
Review from Alice

1. Pricing heading
   Feedback: Make this heading bigger.
   Source: src/components/PricingSection.tsx

2. Signup button
   Feedback: Change this text to Start Free Trial.
   Source: src/components/SignupButton.tsx
```

The dashboard clearly marks source mappings as either:

- direct: produced by build-time instrumentation;
- approximate: inferred from selectors, classes, text, route, and repository search;
- unresolved: no useful source candidate was found.

Submitting feedback does not automatically execute a coding agent.

## 8. Developer Starts the Coding Job

After inspecting the feedback, the developer clicks **Generate Fix PR**.

This approval boundary prevents a client from directly executing code or starting jobs against the developer's repository.

One submitted review can create at most one draft pull request unless the developer explicitly retries a failed job.

## 9. Tool Creates an Isolated Worktree

The tool creates a temporary Git worktree from the commit recorded when the review was created.

Example:

```text
Original repository:
C:\projects\client-website

Temporary worktree:
C:\temp\pinpoint-review-abc123
```

The coding agent works only inside the temporary worktree. It does not edit the developer's current working directory.

The tool creates a generated branch such as:

```text
pinpoint/review-abc123
```

## 10. Coding Agent Implements the Feedback

The first coding-agent runner uses the installed Claude Code CLI behind a replaceable runner interface.

This design allows other agents, such as Codex, OpenCode, or Hermes, to be added later without rewriting the feedback system.

Claude receives:

- the grouped client feedback;
- mapped source files and components;
- DOM and text context;
- the repository worktree;
- the required verification commands;
- instructions to stay within the feedback scope.

Example task:

```text
Source: src/components/PricingSection.tsx
Element: pricing heading
Feedback: Make this heading bigger.

Source: src/components/SignupButton.tsx
Element: signup button
Feedback: Change this text to Start Free Trial.
```

Claude reads the codebase, makes the changes, and runs the repository's checks.

## 11. Tool Verifies the Changes

The tool establishes a test/build baseline before making changes when possible.

After the coding agent finishes, the tool checks:

- whether files were changed;
- whether changes remain inside the worktree;
- whether configured tests pass;
- whether linting passes when available;
- whether the project build passes;
- whether the branch can be safely pushed.

If no files changed, no pull request is created.

If verification fails:

```text
Status: Failed verification
Pull request: Not created
```

The dashboard displays a sanitized job log so the developer can understand the failure.

## 12. Tool Opens a Draft GitHub Pull Request

When verification succeeds, the tool:

1. commits the changes on the generated branch;
2. pushes the branch to the GitHub remote;
3. opens a draft pull request using GitHub CLI;
4. stores the pull-request URL in the job record;
5. displays the URL in the developer dashboard.

The draft pull request includes:

- the client's feedback summary;
- the reviewer name;
- files changed;
- verification commands and results;
- a reference to the original review.

## 13. Developer Makes the Final Decision

The application never automatically merges the pull request.

The developer reviews the draft on GitHub and chooses whether to:

- approve and merge it;
- request changes;
- modify the branch manually;
- close the pull request.

## Preview Modes

### Repository Build Mode

This is the preferred mode.

The tool receives a local GitHub repository, instruments its source in a temporary preview copy, and builds or serves it. This mode provides the most reliable source-file mapping.

### Remote Public URL Mode

The tool can proxy a public landing-page URL while also receiving the corresponding local GitHub repository.

Because the already-deployed page does not contain build-time source metadata, source matching is best effort. The tool uses:

- visible text;
- IDs and class names;
- DOM selector;
- route;
- nearby content;
- repository search;
- coding-agent reasoning.

Authenticated applications and websites that block proxying are outside the first version's reliable support boundary.

## Local JSON Storage

The first version uses JSON files instead of an external database:

```text
data/
  projects.json
  reviews.json
  jobs.json
  logs/
    <job-id>.log
```

Writes use a temporary file followed by an atomic rename to reduce corruption risk.

Storage is accessed through an interface so a hosted database such as Postgres can replace JSON later.

## Safety Rules

- Client submission never directly runs the coding agent.
- The developer must approve a job from the dashboard.
- Coding happens in an isolated Git worktree.
- The original working directory is not edited.
- The repository must be clean before creating a review.
- GitHub and coding-agent credentials are never sent to the client.
- Failed tests or builds prevent pushing and PR creation.
- Pull requests are always drafts.
- The system never automatically merges.
- The system never force-pushes.

## Features to Remove from Toss

The pruned application removes functionality unrelated to visual feedback and autonomous fixes:

- Cloudflare Workers deployment;
- Vercel deployment;
- D1, KV, Postgres, and Blob integrations;
- infrastructure setup and destroy commands;
- member and administrator tokens;
- multi-tenant roles;
- password-protected shares;
- expiring links;
- artifact listing, revocation, and cleanup;
- multiple Toss profiles;
- old share and version commands;
- custom-domain management;
- database migrations;
- AI-skill installation commands;
- legacy command compatibility;
- Toss-specific release machinery and documentation.

## First-Version Success Criteria

The first version is successful when it can demonstrate this complete path:

1. Open a clean plain HTML or React/Next.js GitHub repository.
2. Start an instrumented local review preview.
3. Let a client click multiple elements and write feedback.
4. Preserve annotations as browser drafts until submission.
5. Save the submitted review to JSON.
6. Display the review and source mappings in a developer dashboard.
7. Create an isolated worktree after developer approval.
8. Run Claude Code against the grouped feedback.
9. Run the repository's verification commands.
10. Push a generated branch and open a draft GitHub pull request.
11. Display the pull-request link in the dashboard.
12. Leave the final merge decision to the developer.
