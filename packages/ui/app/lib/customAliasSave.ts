/**
 * Ordered two-request commit for a custom-source save.
 *
 * The alias map is rewritten from a freshly fetched baseline (last-write-wins,
 * see design §2) and committed *before* the sources table so that deleting a
 * source strips its `sourceId/*` entries before the source disappears. The
 * helper returns a discriminated result instead of throwing so the caller can
 * distinguish "aliases saved, sources failed" from a pre-commit failure and
 * choose the right toast.
 */

import { deriveSourceAliases, type SourceChanges } from './sourceAliases';
import { GATEWAY, withUiHeaders } from './utils';

export interface CustomAliasSaveInput {
  /** Sources whose alias editors reported this round (authoritative namespaces). */
  changes: SourceChanges;
  /** The existing `/api/providers` body (full sources table). */
  sourcesBody: Record<string, unknown>;
}

export type CustomAliasSaveResult =
  { ok: true } | { ok: false; stage: 'aliases' | 'sources'; detail?: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* non-JSON body: fall back to the status line */
  }
  return `HTTP ${res.status}`;
}

export async function commitCustomAliasSave({
  changes,
  sourcesBody,
}: CustomAliasSaveInput): Promise<CustomAliasSaveResult> {
  // Nothing to rewrite: skip the baseline read and the (no-op) aliases POST so a
  // transient `/api/model-aliases` failure cannot block a sources-only save.
  if (changes.length > 0) {
    let prevGlobal: Record<string, string>;
    try {
      const res = await fetch(`${GATEWAY}/api/model-aliases`, withUiHeaders());
      if (!res.ok) return { ok: false, stage: 'aliases', detail: await errorDetail(res) };
      const json = (await res.json()) as { modelAliases?: Record<string, string> };
      prevGlobal = json.modelAliases ?? {};
    } catch (err) {
      return { ok: false, stage: 'aliases', detail: errorMessage(err) };
    }

    const modelAliases = deriveSourceAliases(prevGlobal, changes);

    try {
      const res = await fetch(
        `${GATEWAY}/api/model-aliases`,
        withUiHeaders({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelAliases }),
        }),
      );
      if (!res.ok) return { ok: false, stage: 'aliases', detail: await errorDetail(res) };
    } catch (err) {
      return { ok: false, stage: 'aliases', detail: errorMessage(err) };
    }
  }

  try {
    const res = await fetch(
      `${GATEWAY}/api/providers`,
      withUiHeaders({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sourcesBody),
      }),
    );
    if (!res.ok) return { ok: false, stage: 'sources', detail: await errorDetail(res) };
  } catch (err) {
    return { ok: false, stage: 'sources', detail: errorMessage(err) };
  }

  return { ok: true };
}
