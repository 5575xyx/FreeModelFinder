import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelInfo } from '@freemodelfinder/core';
import { catalogSignature } from '../catalog-signature.js';

function model(partial: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'provider'>): ModelInfo {
  return { displayName: partial.id, free: true, ...partial };
}

describe('catalogSignature', () => {
  it('is order-insensitive so a reshuffled catalog is not read as a change', () => {
    const models = [
      model({ id: 'a', provider: 'openrouter' }),
      model({ id: 'b', provider: 'nvidia' }),
      model({ id: 'c', provider: 'custom' }),
    ];

    assert.equal(
      catalogSignature(models),
      catalogSignature([models[2]!, models[0]!, models[1]!]),
      'the same models in a different order must produce the same signature',
    );
  });

  it('changes when a model is added or removed', () => {
    const base = [model({ id: 'a', provider: 'openrouter' })];
    assert.notEqual(catalogSignature(base), catalogSignature([]));
    assert.notEqual(
      catalogSignature(base),
      catalogSignature([...base, model({ id: 'b', provider: 'openrouter' })]),
    );
  });

  it('changes when an entry gains a display name', () => {
    const bare = model({ id: 'a', provider: 'openrouter', displayName: '' });
    const named = model({ id: 'a', provider: 'openrouter', displayName: 'A' });
    assert.notEqual(catalogSignature([bare]), catalogSignature([named]));
  });

  it('distinguishes identical ids from different providers', () => {
    assert.notEqual(
      catalogSignature([model({ id: 'shared', provider: 'openrouter' })]),
      catalogSignature([model({ id: 'shared', provider: 'nvidia' })]),
    );
  });
});
