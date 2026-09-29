import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonCache<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function writeJsonCache(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    await rename(temp, path);
  } catch {
    await rm(path, { force: true });
    await rename(temp, path);
  }
}
