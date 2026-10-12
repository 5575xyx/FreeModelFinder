import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EMPTY_REMOVAL_CLEANUP_LOG,
  appendToRemovalCleanupLog,
  type RemovalCleanupEntry,
  type RemovalCleanupLog,
} from '@freemodelfinder/core';
import { CONFIG_DIR } from '@freemodelfinder/core';

const CLEANUP_LOG_PATH = join(CONFIG_DIR, 'removal-cleanup-log.json');

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

export async function loadRemovalCleanupLog(): Promise<RemovalCleanupLog> {
  if (!existsSync(CLEANUP_LOG_PATH)) return EMPTY_REMOVAL_CLEANUP_LOG;
  try {
    const raw = await readFile(CLEANUP_LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RemovalCleanupLog>;
    return { entries: parsed.entries ?? [] };
  } catch {
    return EMPTY_REMOVAL_CLEANUP_LOG;
  }
}

export async function saveRemovalCleanupLog(log: RemovalCleanupLog): Promise<void> {
  await ensureDir(dirname(CLEANUP_LOG_PATH));
  const tmpPath = `${CLEANUP_LOG_PATH}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(log, null, 2);
  try {
    await writeFile(tmpPath, payload, { mode: 0o600 });
    await rename(tmpPath, CLEANUP_LOG_PATH);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Load the cleanup log, append a new entry, and persist the result.
 * Returns the updated log.
 */
export async function recordRemovalCleanup(entry: RemovalCleanupEntry): Promise<RemovalCleanupLog> {
  const current = await loadRemovalCleanupLog();
  const next = appendToRemovalCleanupLog(current, entry);
  await saveRemovalCleanupLog(next);
  return next;
}

/** Reset the persisted cleanup log to empty (used by tests and operators). */
export async function clearRemovalCleanupLog(): Promise<RemovalCleanupLog> {
  await saveRemovalCleanupLog(EMPTY_REMOVAL_CLEANUP_LOG);
  return EMPTY_REMOVAL_CLEANUP_LOG;
}
