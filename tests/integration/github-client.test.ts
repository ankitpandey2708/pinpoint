import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftPullRequest } from '../../src/github/client';

let dir: string;
let fakeGit: string;
let fakeGh: string;
let gitArgsFile: string;
let ghArgsFile: string;
let ghBodyFile: string;

const FAKE_GIT = `
const fs = require('fs');
fs.writeFileSync(process.env.GIT_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`;

const FAKE_GH = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.GH_ARGS_FILE, JSON.stringify(argv));
const i = argv.indexOf('--body-file');
if (i >= 0) fs.writeFileSync(process.env.GH_BODY_FILE, fs.readFileSync(argv[i + 1], 'utf8'));
if (process.env.GH_MODE === 'fail') { process.stderr.write('gh boom'); process.exit(1); }
process.stdout.write('https://github.com/acme/site/pull/42\\n');
process.exit(0);
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-gh-'));
  fakeGit = join(dir, 'fake-git.js');
  fakeGh = join(dir, 'fake-gh.js');
  gitArgsFile = join(dir, 'git-args.json');
  ghArgsFile = join(dir, 'gh-args.json');
  ghBodyFile = join(dir, 'gh-body.txt');
  await writeFile(fakeGit, FAKE_GIT, 'utf8');
  await writeFile(fakeGh, FAKE_GH, 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseInput(mode = 'ok') {
  return {
    cwd: dir,
    branch: 'pinpoint/review-abc123',
    baseBranch: 'main',
    remote: 'origin',
    repo: 'acme/site',
    title: 'Apply visual feedback from Alice',
    body: 'Reviewer: Alice\n\n1. Make the heading bigger (index.html)\n',
    git: [process.execPath, fakeGit],
    gh: [process.execPath, fakeGh],
    env: {
      ...process.env,
      GIT_ARGS_FILE: gitArgsFile,
      GH_ARGS_FILE: ghArgsFile,
      GH_BODY_FILE: ghBodyFile,
      GH_MODE: mode,
    },
  };
}

describe('createDraftPullRequest', () => {
  it('pushes the branch and opens a draft PR, returning url and number', async () => {
    const result = await createDraftPullRequest(baseInput('ok'));
    expect(result.url).toBe('https://github.com/acme/site/pull/42');
    expect(result.number).toBe(42);

    const gitArgs = JSON.parse(await readFile(gitArgsFile, 'utf8')) as string[];
    expect(gitArgs).toEqual(['push', '-u', 'origin', 'pinpoint/review-abc123']);
    // Never force-push.
    expect(gitArgs).not.toContain('--force');
    expect(gitArgs).not.toContain('-f');
    expect(gitArgs).not.toContain('--force-with-lease');

    const ghArgs = JSON.parse(await readFile(ghArgsFile, 'utf8')) as string[];
    expect(ghArgs.slice(0, 3)).toEqual(['pr', 'create', '--draft']);
    expect(ghArgs).toContain('--base');
    expect(ghArgs[ghArgs.indexOf('--base') + 1]).toBe('main');
    expect(ghArgs).toContain('--head');
    expect(ghArgs[ghArgs.indexOf('--head') + 1]).toBe('pinpoint/review-abc123');
    expect(ghArgs).toContain('--title');
    expect(ghArgs).toContain('--body-file');

    const body = await readFile(ghBodyFile, 'utf8');
    expect(body).toContain('Reviewer: Alice');
    expect(body).toContain('index.html');
  });

  it('propagates a failure from gh', async () => {
    await expect(createDraftPullRequest(baseInput('fail'))).rejects.toThrow();
  });
});
