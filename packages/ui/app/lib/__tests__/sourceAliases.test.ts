import { describe, expect, it } from 'vitest';
import { deriveSourceAliases, findLegacyBareAliases } from '../sourceAliases';

describe('deriveSourceAliases', () => {
  it('writes edited alias rows as 来源id/别名 → composed target', () => {
    const out = deriveSourceAliases({}, [
      {
        id: 'novaway',
        models: ['glm-5.3', 'qwen-8b'],
        aliases: [{ alias: 'glm', targetModel: 'glm-5.3' }],
      },
    ]);
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:glm-5.3' });
  });

  it('clears the source namespace then writes edits; removed models are gone', () => {
    const prev = {
      'novaway/glm': 'custom:novaway:glm-5.3',
      'novaway/old': 'custom:novaway:old-model',
    };
    // novaway is in the rewrite set with no reported rows → whole namespace cleared.
    const out = deriveSourceAliases(prev, [{ id: 'novaway', models: ['glm-5.3'], aliases: [] }]);
    expect(out).toEqual({});
  });

  it('deletes a still-valid alias when the editor reports no row for it', () => {
    // glm-5.3 still exists, yet the user deleted the `glm` row → deletion is real.
    const prev = { 'novaway/glm': 'custom:novaway:glm-5.3' };
    const out = deriveSourceAliases(prev, [{ id: 'novaway', models: ['glm-5.3'], aliases: [] }]);
    expect(out).toEqual({});
  });

  it("preserves other sources' prefixed entries and bare legacy entries", () => {
    const prev = {
      'cpa/gpt': 'custom:cpa:gpt-mini',
      legacyname: 'custom:cpa:gpt-mini', // bare, kept as-is
    };
    // only novaway is being saved this round; cpa + bare must survive
    const out = deriveSourceAliases(prev, [{ id: 'novaway', models: ['glm-5.3'], aliases: [] }]);
    expect(out['cpa/gpt']).toBe('custom:cpa:gpt-mini');
    expect(out['legacyname']).toBe('custom:cpa:gpt-mini');
    expect(Object.keys(out)).toHaveLength(2);
  });

  it('replaces a previous edit to the same alias row (no duplicate key)', () => {
    const prev = { 'novaway/glm': 'custom:novaway:glm-5.3' };
    const out = deriveSourceAliases(prev, [
      {
        id: 'novaway',
        models: ['glm-5.3', 'qwen-8b'],
        aliases: [{ alias: 'glm', targetModel: 'qwen-8b' }],
      },
    ]);
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:qwen-8b' });
  });

  it('drops a reported row whose target model was removed from the source', () => {
    // The editor hydrates once per source, so after the user deletes model
    // `old-model` it still reports the `old` row. The rewrite must drop it
    // rather than write back a dangling `novaway/old`.
    const prev = {};
    const out = deriveSourceAliases(prev, [
      {
        id: 'novaway',
        models: ['glm-5.3'],
        aliases: [
          { alias: 'glm', targetModel: 'glm-5.3' },
          { alias: 'old', targetModel: 'old-model' },
        ],
      },
    ]);
    expect(out).toEqual({ 'novaway/glm': 'custom:novaway:glm-5.3' });
  });

  it('findLegacyBareAliases returns only prefix-less entries', () => {
    const rows = findLegacyBareAliases({ 'novaway/glm': 'x', legacy1: 'y', legacy2: 'z' });
    expect(rows.map((r) => r.alias).sort()).toEqual(['legacy1', 'legacy2']);
  });
});
