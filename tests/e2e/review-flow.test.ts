// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const overlaySource = readFileSync(join(__dirname, '../../src/public/overlay.js'), 'utf8');

interface FetchCall {
  url: string;
  options: RequestInit | undefined;
}

interface Controller {
  draftKey: string;
  select(el: Element): void;
  comment(elementId: string, text: string): void;
  remove(elementId: string): void;
  annotations(): { elementId: string; comment: string }[];
  setReviewer(name: string): void;
  submit(): Promise<{ ok: boolean; id?: string; error?: string }>;
}

interface PinpointGlobal {
  init(config: Record<string, unknown>): Controller;
}

function loadOverlay(): PinpointGlobal {
  // Evaluate the framework-free browser script into the jsdom window scope.
  // eslint-disable-next-line no-eval
  (0, eval)(overlaySource);
  return (window as unknown as { Pinpoint: PinpointGlobal }).Pinpoint;
}

let calls: FetchCall[];

function makeConfig() {
  const fetchImpl = async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: 'rev_1' }),
    } as Response;
  };
  return {
    projectId: 'proj_1',
    reviewKey: 'c0ffee',
    route: '/',
    apiBase: '/api',
    fetch: fetchImpl,
  };
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  document.body.innerHTML = `
    <h1 data-pinpoint-id="e1">Pricing</h1>
    <button data-pinpoint-id="e2" class="cta">Sign up</button>
  `;
});

describe('review overlay controller', () => {
  it('selects elements, edits and deletes comments, recovers a draft, and submits', () => {
    const Pinpoint = loadOverlay();
    const app = Pinpoint.init(makeConfig());

    app.select(document.querySelector('[data-pinpoint-id="e1"]')!);
    app.comment('e1', 'Make this bigger');
    app.select(document.querySelector('[data-pinpoint-id="e2"]')!);
    app.comment('e2', 'Change text');
    expect(app.annotations()).toHaveLength(2);

    // Edit
    app.comment('e1', 'Make this MUCH bigger');
    expect(app.annotations().find((a) => a.elementId === 'e1')?.comment).toBe('Make this MUCH bigger');

    // Delete
    app.remove('e2');
    expect(app.annotations()).toHaveLength(1);

    // Draft persisted to localStorage
    expect(localStorage.getItem(app.draftKey)).toBeTruthy();
  });

  it('recovers a draft across a fresh init and clears it only after a successful submit', async () => {
    const Pinpoint = loadOverlay();
    const first = Pinpoint.init(makeConfig());
    first.select(document.querySelector('[data-pinpoint-id="e1"]')!);
    first.comment('e1', 'Make this bigger');

    // Simulate a page refresh: a new controller recovers the draft.
    const second = Pinpoint.init(makeConfig());
    expect(second.annotations()).toHaveLength(1);

    // Reviewer name is optional: submitting without one still succeeds and the
    // client sends "Anonymous".
    const ok = await second.submit();
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe('rev_1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/projects/proj_1/reviews');
    expect(calls[0].options?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].options?.body)).reviewerName).toBe('Anonymous');

    // Draft cleared after success.
    expect(localStorage.getItem(second.draftKey)).toBeNull();
    const third = Pinpoint.init(makeConfig());
    expect(third.annotations()).toHaveLength(0);
  });

  it('rejects submission when there are no comments', async () => {
    const Pinpoint = loadOverlay();
    const app = Pinpoint.init(makeConfig());
    app.setReviewer('Alice');
    const res = await app.submit();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/comment/i);
    expect(calls).toHaveLength(0);
  });
});
