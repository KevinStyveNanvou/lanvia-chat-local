import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPathInside, safeDestination, sanitizeFileName, sha256File, validateSourceFile } from '../src/main/security/files';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('file safety and integrity', () => {
  it('sanitizes names and constrains destination paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lanvia-test-')); dirs.push(root);
    const destination = await safeDestination(root, '../../evil<>.txt');
    expect(path.basename(destination.finalPath)).toBe('evil__.txt');
    expect(isPathInside(root, destination.finalPath)).toBe(true);
    expect(isPathInside(root, path.join(root, '..', 'evil.txt'))).toBe(false);
    expect(sanitizeFileName('..')).toBe('LANVIA-file');
  });

  it('hashes a stream using SHA-256 and validates regular files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lanvia-test-')); dirs.push(root);
    const file = path.join(root, 'hello.txt');
    await writeFile(file, 'Hello from LANVIA');
    expect(await sha256File(file)).toBe('9ceff3bb9dd4c27c505abe71cb808abaa96214f1e75af6a5dc915d29a6b80f17');
    expect((await validateSourceFile(file)).size).toBe((await readFile(file)).length);
    await expect(validateSourceFile(root)).rejects.toThrow('regular file');
  });
});
