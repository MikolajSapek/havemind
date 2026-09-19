/**
 * Applied migrations are frozen, byte for byte.
 *
 * `migrationChecksum` hashes the whole file: `canonicalizeSql` normalises only
 * a BOM and line endings, so a comment is part of the hash. Editing the prose
 * in an already-applied migration therefore makes a live server refuse to
 * start, with `MigrationChecksumError`, on a database that is perfectly fine.
 *
 * That is not hypothetical. A repository-wide em-dash cleanup rewrote one
 * comment line each in migrations 5, 6 and 7; the schema was untouched, and the
 * sapserver deployment still went into a restart loop until the files were put
 * back. The guard below pins the checksums so the next such edit fails here
 * instead of in production.
 *
 * To ADD a migration, append its checksum. To CHANGE an applied one, don't:
 * write a new migration instead.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MIGRATIONS, migrationChecksum } from './migrations.js';

/** Checksums as deployed. Never edit an entry; only append new ones. */
const FROZEN: Readonly<Record<number, string>> = {
  1: '76907d48960c264a19a574c53607fce967667c388485e3260aba6c4783ab7725',
  2: '574f2e78622e12193fbcfa36fddba51547c83af2463372826da5ab4823cea2e0',
  3: '96a056fb226335ca5bf8b20f18b911167216e340fd2cf5d1519b005a213d3eb7',
  4: '04a01c54e8d3719dd707668395e149c2252faa215709ce25ec2721fa8b2f34b1',
  5: '4e2648b5af4176183695a36768dae825b9578842f17a4dc405127914b8efb210',
  6: '409bb2b61baff58c40ee7d5d6f40dba6f4a147891a48ab9e81b6393ac99efe2f',
  7: 'b667f3f25d6b27dcd798156ba7f5ebf5d570757a3151a410da0d966665e30ad6',
};

describe('applied migrations are immutable', () => {
  it('never changes the checksum of a migration that has shipped', () => {
    for (const migration of DEFAULT_MIGRATIONS) {
      const frozen = FROZEN[migration.version];
      if (frozen === undefined) continue;
      expect(
        migrationChecksum(migration.sql),
        `migration ${migration.version} (${migration.name}) changed: a live ` +
          `database will refuse to start. Add a new migration instead.`,
      ).toBe(frozen);
    }
  });

  it('pins every migration that exists today', () => {
    // Guards the guard: an empty FROZEN map would make the test above vacuous.
    const pinned = Object.keys(FROZEN).length;
    expect(pinned, 'FROZEN must cover every shipped migration').toBe(
      DEFAULT_MIGRATIONS.length,
    );
  });
});
