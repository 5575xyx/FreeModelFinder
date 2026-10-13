/**
 * Persist one model-alias edit against the whole-table `/api/model-aliases`
 * endpoint: fetch the freshest server table, apply the edit, replace the
 * table, and return the server-confirmed result. Throws an `Error` on any
 * failure so the caller can keep its previous state untouched.
 *
 * The endpoint replaces the ENTIRE table, so the read-modify-write must not
 * interleave with another save: two overlapping calls would both read the
 * same baseline and the second POST would silently drop the first edit (a
 * lost update, not last-wins). Every call is therefore chained onto a
 * module-level queue; the internal chain swallows rejections so a failed
 * save never poisons the queue, while each caller still sees its own error
 * through the returned promise.
 */

import { applyAliasEdit } from './modelAliases';
import { GATEWAY, withUiHeaders } from './utils';

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* non-JSON body: fall back to the status line */
  }
  return `HTTP ${res.status}`;
}

async function commitAliasEdit(target: string, name: string): Promise<Record<string, string>> {
  const getRes = await fetch(`${GATEWAY}/api/model-aliases`, withUiHeaders());
  if (!getRes.ok) throw new Error(await errorDetail(getRes));
  const base =
    ((await getRes.json()) as { modelAliases?: Record<string, string> }).modelAliases ?? {};

  const postRes = await fetch(
    `${GATEWAY}/api/model-aliases`,
    withUiHeaders({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelAliases: applyAliasEdit(base, target, name) }),
    }),
  );
  if (!postRes.ok) throw new Error(await errorDetail(postRes));
  return ((await postRes.json()) as { modelAliases?: Record<string, string> }).modelAliases ?? {};
}

let aliasSaveQueue: Promise<unknown> = Promise.resolve();

export async function saveAlias(target: string, name: string): Promise<Record<string, string>> {
  const operation = aliasSaveQueue.then(() => commitAliasEdit(target, name));
  aliasSaveQueue = operation.catch(() => undefined);
  return operation;
}
