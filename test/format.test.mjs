import { test } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { parseMarketIndex, useSemver, MAX_INLINE_ICON_BYTES } from '../scripts/lib/format.mjs';

useSemver(semver);

const URL_BASE = 'https://market.example/dsh/index.json';

function base(overrides = {}) {
  return {
    format: 1,
    title: 'Example',
    plugins: [
      {
        name: 'dsh-plugin-a',
        versions: [{ version: '1.0.0', publishTimestamp: 1_700_000_000, source: { type: 'npm' } }],
      },
    ],
    ...overrides,
  };
}

test('minimal document parses and fills defaults', () => {
  const parsed = parseMarketIndex(base(), URL_BASE);
  assert.equal(parsed.plugins[0].name, 'dsh-plugin-a');
  assert.deepEqual(parsed.metadata, { categories: {}, labels: {}, sortKeys: {} });
});

test('unknown members are dropped, not rejected', () => {
  const document = base({ extra: true, plugins: [{ ...base().plugins[0], distTags: {} }] });
  const parsed = parseMarketIndex(document, URL_BASE);
  assert.equal(parsed.extra, undefined);
  assert.equal(parsed.plugins[0].distTags, undefined);
});

test('relative icon resolves against the index URL', () => {
  const document = base({ plugins: [{ ...base().plugins[0], icon: 'icons/a.svg' }] });
  assert.equal(parseMarketIndex(document, URL_BASE).plugins[0].icon, 'https://market.example/dsh/icons/a.svg');
});

test('cross-origin http icon is rejected', () => {
  const document = base({ plugins: [{ ...base().plugins[0], icon: 'http://evil.example/a.svg' }] });
  assert.throws(() => parseMarketIndex(document, URL_BASE), /must resolve to https or the index origin/u);
});

test('inline icon over 32 KiB decoded is rejected', () => {
  const payload = Buffer.alloc(MAX_INLINE_ICON_BYTES + 1, 0).toString('base64');
  const document = base({ plugins: [{ ...base().plugins[0], icon: `data:image/png;base64,${payload}` }] });
  assert.throws(() => parseMarketIndex(document, URL_BASE), /must not exceed 32 KiB/u);
});

test('duplicate version and duplicate name are rejected', () => {
  const duplicateVersion = base({
    plugins: [
      {
        name: 'dsh-plugin-a',
        versions: [
          { version: '1.0.0', publishTimestamp: 1_700_000_000, source: { type: 'npm' } },
          { version: '1.0.0', publishTimestamp: 1_700_000_001, source: { type: 'npm' } },
        ],
      },
    ],
  });
  assert.throws(() => parseMarketIndex(duplicateVersion, URL_BASE), /duplicates 1\.0\.0/u);
  const duplicateName = base({ plugins: [base().plugins[0], base().plugins[0]] });
  assert.throws(() => parseMarketIndex(duplicateName, URL_BASE), /duplicates dsh-plugin-a/u);
});

test('millisecond timestamps are rejected', () => {
  const document = base({ plugins: [{ name: 'x', versions: [{ version: '1.0.0', publishTimestamp: 1_700_000_000_000, source: { type: 'npm' } }] }] });
  assert.throws(() => parseMarketIndex(document, URL_BASE), /Unix seconds/u);
});

test('undeclared category/label/sortKey reference is rejected', () => {
  const document = base({
    metadata: { categories: { tools: { title: 'Tools' } } },
    plugins: [{ ...base().plugins[0], metadata: { category: 'unknown' } }],
  });
  assert.throws(() => parseMarketIndex(document, URL_BASE), /undeclared id/u);
});

test('git source requires an exact lowercase commit', () => {
  const document = base({
    plugins: [
      {
        name: 'dsh-plugin-git',
        versions: [{ version: '0.1.0', publishTimestamp: 1_700_000_000, source: { type: 'git', url: 'https://github.com/a/b', commit: 'ABC' } }],
      },
    ],
  });
  assert.throws(() => parseMarketIndex(document, URL_BASE), /40-hex-digit commit SHA/u);
});

test('versions are sorted by descending semver on parse', () => {
  const document = base({
    plugins: [
      {
        name: 'dsh-plugin-a',
        versions: [
          { version: '1.0.0', publishTimestamp: 1_700_000_000, source: { type: 'npm' } },
          { version: '2.0.0', publishTimestamp: 1_700_000_000, source: { type: 'npm' } },
        ],
      },
    ],
  });
  const parsed = parseMarketIndex(document, URL_BASE);
  assert.deepEqual(parsed.plugins[0].versions.map((entry) => entry.version), ['2.0.0', '1.0.0']);
});
