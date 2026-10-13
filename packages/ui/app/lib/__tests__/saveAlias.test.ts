import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { gateway, server } from '../../../test/server';
import { AliasConflictError, saveAlias } from '../saveAlias';

const ALIASES_URL = `${gateway}/api/model-aliases`;

type AliasTable = Record<string, string>;

/**
 * Installs a mutable server-side table: every GET returns the current state,
 * every POST reads its body, stores it, and echoes it back. This is what a
 * real whole-table-replace endpoint does, and what makes the concurrency test
 * able to observe a lost update.
 */
function useMutableAliasTable(initial: AliasTable) {
  let table: AliasTable = { ...initial };
  const posted: AliasTable[] = [];
  server.use(
    http.get(ALIASES_URL, () => HttpResponse.json({ modelAliases: table })),
    http.post(ALIASES_URL, async ({ request }) => {
      const body = (await request.json()) as { modelAliases?: AliasTable };
      table = body.modelAliases ?? {};
      posted.push(table);
      return HttpResponse.json({ ok: true, modelAliases: table });
    }),
  );
  return { posted, current: () => table };
}

describe('saveAlias', () => {
  it('rebases on the freshly fetched server table and returns the confirmed table', async () => {
    const posted: AliasTable[] = [];
    let getCount = 0;
    let postCount = 0;
    server.use(
      http.get(ALIASES_URL, () => {
        getCount += 1;
        return HttpResponse.json({ modelAliases: { 'cli-added': 'other:model' } });
      }),
      http.post(ALIASES_URL, async ({ request }) => {
        postCount += 1;
        const body = (await request.json()) as { modelAliases?: AliasTable };
        posted.push(body.modelAliases ?? {});
        // The confirmed table deliberately differs from the posted body: an
        // implementation returning its locally computed next table fails.
        return HttpResponse.json({ ok: true, modelAliases: { shorty: 'openrouter:gpt-4o-mini' } });
      }),
    );

    const result = await saveAlias('openrouter:gpt-4o-mini', 'shorty');

    // Review Focus #3: the POST body keeps the server-side baseline entry the
    // caller never knew about — the base must come from this round's GET.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      'cli-added': 'other:model',
      shorty: 'openrouter:gpt-4o-mini',
    });
    // The return value is the server's reply, not the locally computed table.
    expect(result).toEqual({ shorty: 'openrouter:gpt-4o-mini' });
    expect(getCount).toBe(1);
    expect(postCount).toBe(1);
  });

  it('clears an alias by posting a table without it', async () => {
    const { posted, current } = useMutableAliasTable({ glm: 'custom:novay:glm-5.3' });

    await saveAlias('custom:novay:glm-5.3', '');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({});
    expect(current()).toEqual({});
  });

  it('renames an alias by dropping the old name and writing the new one', async () => {
    const target = 'custom:novay:glm-5.3';
    const { posted } = useMutableAliasTable({ glm: target });

    await saveAlias(target, 'gpt');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ gpt: target });
  });

  it('rejects instead of silently overwriting a name already owned by another target', async () => {
    // The caller's local map may be stale (initial GET failed, sign-in just
    // happened, or the CLI added this alias out-of-band): the fresh table is
    // the authority, and stealing `shorty` from `other:model` must not POST.
    const { posted, current } = useMutableAliasTable({ shorty: 'other:model' });

    const rejection = saveAlias('openrouter:gpt-4o-mini', 'shorty');
    await expect(rejection).rejects.toBeInstanceOf(AliasConflictError);
    await expect(rejection).rejects.toMatchObject({
      name: 'AliasConflictError',
      aliasError: { key: 'finder.alias.error.taken' },
    });

    expect(posted).toHaveLength(0);
    expect(current()).toEqual({ shorty: 'other:model' });
  });

  it('rejects with the server error when the POST is rejected', async () => {
    server.use(
      http.get(ALIASES_URL, () => HttpResponse.json({ modelAliases: {} })),
      http.post(ALIASES_URL, () =>
        HttpResponse.json({ error: 'alias "auto" is a reserved routing keyword' }, { status: 400 }),
      ),
    );

    await expect(saveAlias('openrouter:gpt-4o-mini', 'auto')).rejects.toThrow('reserved');
  });

  it('rejects when the baseline GET fails and never posts', async () => {
    const { posted } = useMutableAliasTable({});
    server.use(http.get(ALIASES_URL, () => HttpResponse.json({}, { status: 500 })));

    await expect(saveAlias('openrouter:gpt-4o-mini', 'shorty')).rejects.toThrow();
    expect(posted).toHaveLength(0);
  });

  it('serializes concurrent saves so no edit is lost', async () => {
    const { current } = useMutableAliasTable({});

    await Promise.all([
      saveAlias('openrouter:gpt-4o-mini', 'a'),
      saveAlias('custom:novay:glm-5.3', 'b'),
    ]);

    expect(current()).toEqual({
      a: 'openrouter:gpt-4o-mini',
      b: 'custom:novay:glm-5.3',
    });
  });

  it('keeps the queue usable after a failed save', async () => {
    let rejectNext = true;
    server.use(
      http.get(ALIASES_URL, () => HttpResponse.json({ modelAliases: {} })),
      http.post(ALIASES_URL, () => {
        if (rejectNext) {
          rejectNext = false;
          return HttpResponse.json({ error: 'server said no' }, { status: 400 });
        }
        return HttpResponse.json({ ok: true, modelAliases: { retry: 'openrouter:gpt-4o-mini' } });
      }),
    );

    await expect(saveAlias('openrouter:gpt-4o-mini', 'first')).rejects.toThrow('server said no');
    await expect(saveAlias('openrouter:gpt-4o-mini', 'retry')).resolves.toEqual({
      retry: 'openrouter:gpt-4o-mini',
    });
  });
});
