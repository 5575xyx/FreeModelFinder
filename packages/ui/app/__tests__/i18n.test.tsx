import { describe, expect, it } from 'vitest';
import { en, zh } from '../i18n';
import { SETTINGS_PROVIDERS, providerHintKey, providerLabelKey } from '../lib/platforms';

const DICTS = { zh, en } as const;
const LANGS = ['zh', 'en'] as const;

describe('i18n provider parity', () => {
  it.each(SETTINGS_PROVIDERS.map((p) => [p.id] as const))(
    'provider %s hint exists in zh and en',
    (id) => {
      const hintKey = providerHintKey(id);
      for (const lang of LANGS) {
        const value = DICTS[lang][hintKey];
        expect(value, `${lang} is missing ${hintKey}`).toBeTruthy();
        expect(value?.length, `${lang} ${hintKey} is empty`).toBeGreaterThan(0);
        expect(value, `${lang} ${hintKey} falls back to the raw key`).not.toBe(hintKey);
      }
    },
  );

  it.each(
    SETTINGS_PROVIDERS.map((p) => [p.id] as const).filter(
      ([id]) => providerLabelKey(id) !== undefined,
    ),
  )('provider %s label exists in zh and en', (id) => {
    const labelKey = providerLabelKey(id);
    expect(labelKey).toBeTruthy();
    for (const lang of LANGS) {
      const value = DICTS[lang][labelKey as string];
      expect(value, `${lang} is missing ${labelKey}`).toBeTruthy();
      expect(value?.length, `${lang} ${labelKey} is empty`).toBeGreaterThan(0);
      expect(value, `${lang} ${labelKey} falls back to the raw key`).not.toBe(labelKey);
    }
  });

  it('every provider hint/label key is covered by both dictionaries', () => {
    const keys = SETTINGS_PROVIDERS.flatMap((p) =>
      [providerHintKey(p.id), providerLabelKey(p.id)].filter((k): k is string => k !== undefined),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(zh[key], `zh missing ${key}`).toBeTruthy();
      expect(en[key], `en missing ${key}`).toBeTruthy();
    }
  });

  it('zh and en dictionaries have identical key sets', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
