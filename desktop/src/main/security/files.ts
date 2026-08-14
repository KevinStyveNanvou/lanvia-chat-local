import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '../../shared/constants/protocol.generated';

export function sanitizeFileName(input: string): string {
  const base = path.basename(input).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  const safe = base.slice(0, 180);
  return safe && safe !== '.' && safe !== '..' ? safe : 'LANVIA-file';
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function safeDestination(root: string, requestedName: string): Promise<{ finalPath: string; partPath: string }> {
  await mkdir(root, { recursive: true });
  const safeName = sanitizeFileName(requestedName);
  const parsed = path.parse(safeName);
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index})`;
    const finalPath = path.join(root, `${parsed.name}${suffix}${parsed.ext}`);
    const partPath = `${finalPath}.lanvia.part`;
    if (!isPathInside(root, finalPath) || !isPathInside(root, partPath)) throw new Error('Unsafe destination path');
    if (!existsSync(finalPath) && !existsSync(partPath)) return { finalPath, partPath };
  }
  throw new Error('Unable to allocate destination file name');
}

export async function validateSourceFile(filePath: string): Promise<{ size: number; fileName: string }> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('Selected path is not a regular file');
  if (info.size < 0 || info.size > LIMITS.fileBytes) throw new Error('File exceeds LANVIA size limit');
  return { size: info.size, fileName: sanitizeFileName(path.basename(filePath)) };
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export async function finalizePart(partPath: string, finalPath: string): Promise<void> {
  if (path.dirname(partPath) !== path.dirname(finalPath)) throw new Error('Part and final path must share a directory');
  await rename(partPath, finalPath);
}
