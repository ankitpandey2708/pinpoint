import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeChangedFiles } from '../../src/git/change-policy';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pinpoint-policy-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'Hero.tsx'), 'export const Hero = () => null;', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assertSafeChangedFiles', () => {
  it('allows ordinary source and style changes', async () => {
    await expect(assertSafeChangedFiles(root, ['src/Hero.tsx', 'styles/site.css'])).resolves.toBeUndefined();
  });

  it.each([
    '.github/workflows/deploy.yml',
    '.git/config',
    '.husky/pre-commit',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '.npmrc',
    '.env.production',
    '../outside.txt',
    'C:/outside.txt',
  ])('rejects protected or escaping path %s', async (file) => {
    await expect(assertSafeChangedFiles(root, [file])).rejects.toThrow(/protected|outside|unsafe/i);
  });

  it('rejects a changed symlink', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside', 'utf8');
    const link = join(root, 'src', 'linked.txt');
    await symlink(outside, link);
    await expect(assertSafeChangedFiles(root, ['src/linked.txt'])).rejects.toThrow(/symbolic link/i);
  });
});
