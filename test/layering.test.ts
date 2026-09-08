import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// The layering is enforced by `no-restricted-imports`, which reads one file's
// imports at a time. Two things about the shape of the tree are therefore
// beyond it, and they are here instead.

const SRC = path.join(__dirname, '..', 'src');
const LAYERS = [
  'actions',
  'application',
  'commands',
  'composition',
  'harnesses',
  'infrastructure',
  'prompts',
  'types',
];

/**
 * A file at `src/` root is the one thing the lint cannot classify: a glob can
 * bar `**\/main.js` by name, but it cannot bar "some new sibling", and it
 * cannot tell `src/brand.js` from `src/types/brand.js` by basename either -
 * which is the collision that made the composition root a directory. So the
 * rule is that the root holds `main.ts` and nothing else, and this is what says
 * so. If this fails, the new file belongs in a layer; if it genuinely belongs
 * at the root, every layer's `ROOT` group needs its name before this changes.
 */
test('src/ root holds main.ts alone', () => {
  const roots = fs
    .readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .sort();
  assert.deepEqual(roots, ['main.ts']);
});

/** Every directory in `src/` is a layer the lint has a rule for. */
test('every directory in src/ is a named layer', () => {
  const dirs = fs
    .readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(dirs, [...LAYERS].sort());
});
