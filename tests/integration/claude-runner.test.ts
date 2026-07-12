import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgent } from '../../src/agents/claude';

let dir: string;
let fakeScript: string;
let argsFile: string;
let cwdFile: string;
let stdinFile: string;

// A fake `claude` CLI: records argv and cwd, emits stream-json (with a secret to
// prove redaction), and exits per FAKE_MODE.
const FAKE = `
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.FAKE_CWD_FILE, process.cwd());
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_STDIN_FILE, input);
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', text: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 used' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: mode === 'fail' ? 'error' : 'success' }) + '\\n');
  process.exit(mode === 'fail' ? 1 : 0);
}
});
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pinpoint-claude-'));
  fakeScript = join(dir, 'fake-claude.js');
  argsFile = join(dir, 'args.json');
  cwdFile = join(dir, 'cwd.txt');
  stdinFile = join(dir, 'stdin.txt');
  await writeFile(fakeScript, FAKE, 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function agent(): ClaudeAgent {
  return new ClaudeAgent({ command: [process.execPath, fakeScript] });
}

const baseEnv = () => ({
  ...process.env,
  FAKE_ARGS_FILE: argsFile,
  FAKE_CWD_FILE: cwdFile,
  FAKE_STDIN_FILE: stdinFile,
});

describe('ClaudeAgent', () => {
  it('invokes claude with the exact argument array and worktree cwd', async () => {
    const res = await agent().run(
      { prompt: 'FIX THINGS & echo INJECTION', cwd: dir },
      { env: { ...baseEnv(), FAKE_MODE: 'ok' } },
    );
    expect(res.ok).toBe(true);

    const argv = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    expect(argv).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--bare',
      '--strict-mcp-config',
      '--model',
      'sonnet',
      '--no-session-persistence',
      '--max-turns',
      '30',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
    ]);
    expect(await readFile(stdinFile, 'utf8')).toBe('FIX THINGS & echo INJECTION');

    const usedCwd = (await readFile(cwdFile, 'utf8')).trim().replace(/\\/g, '/');
    expect(usedCwd).toBe(dir.replace(/\\/g, '/'));
  });

  it('parses stream-json events and redacts secrets from the log', async () => {
    const events: string[] = [];
    const res = await agent().run(
      { prompt: 'p', cwd: dir },
      {
        env: { ...baseEnv(), FAKE_MODE: 'ok' },
        onEvent: (e) => events.push(e.type),
      },
    );
    expect(res.ok).toBe(true);
    expect(res.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(events).toEqual(['system', 'assistant', 'result']);
    expect(res.log).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(res.log).toContain('[REDACTED]');
  });

  it('reports a nonzero exit as a failed run', async () => {
    const res = await agent().run(
      { prompt: 'p', cwd: dir },
      { env: { ...baseEnv(), FAKE_MODE: 'fail' } },
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  it('times out a hung agent', async () => {
    const res = await agent().run(
      { prompt: 'p', cwd: dir },
      { env: { ...baseEnv(), FAKE_MODE: 'hang' }, timeoutMs: 300 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('can be cancelled with an abort signal', async () => {
    const controller = new AbortController();
    const p = agent().run(
      { prompt: 'p', cwd: dir },
      { env: { ...baseEnv(), FAKE_MODE: 'hang' }, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.ok).toBe(false);
  });
});
