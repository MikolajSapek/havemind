#!/usr/bin/env node
/**
 * Collapse forked file histories to a single head per file.
 *
 * WHY THIS EXISTS
 *
 * A file normally has exactly one row in `file_heads`. It gets more when two
 * devices commit revisions that do not descend from each other, which is how the
 * DAG records a genuine concurrent edit. Clients surface each extra head as a
 * conflict copy.
 *
 * The plugin bug fixed in 1.4.24 (the own-echo handler storing an envelope hash
 * into a plaintext-hash slot) made every pushed file read as permanently
 * diverged, so it manufactured forks for edits that never actually conflicted.
 * On the pilot vault that left 98 forked files, 75 of which have byte-identical
 * content across their heads: pure artefacts, nothing to choose between.
 *
 * WHAT THIS DOES
 *
 * For every file with more than one head, keeps the most recently accepted
 * revision (ties broken by the higher server_sequence, which is the server's own
 * total order) and drops the other head ROWS.
 *
 * Nothing is deleted beyond those rows: every revision, blob, event and parent
 * link stays exactly as it is, so the losing versions remain in history and stay
 * reachable. This only changes which revision each file currently points at.
 *
 * USAGE
 *   node resolve-forked-heads.mjs <database-path> [--vault <id>] [--apply]
 *                                 [--identical-only]
 *
 * Without `--apply` it reports and changes nothing. `--identical-only` restricts
 * the merge to forks whose heads all share one blob hash, i.e. the provably
 * safe subset where no version can be lost even in principle.
 *
 * Take a backup first.
 */

import Database from 'better-sqlite3';

function parseArgs(argv) {
  const [databasePath, ...rest] = argv;
  if (databasePath === undefined) {
    throw new Error(
      'Usage: node resolve-forked-heads.mjs <database-path> [--vault <id>] [--apply] [--identical-only]',
    );
  }
  let vaultId = null;
  let apply = false;
  let identicalOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply') apply = true;
    else if (flag === '--identical-only') identicalOnly = true;
    else if (flag === '--vault') {
      vaultId = rest[index + 1] ?? null;
      index += 1;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return { databasePath, vaultId, apply, identicalOnly };
}

/**
 * Every file holding more than one head, with the heads ordered newest first.
 * `accepted_at` is the server's own acceptance clock; `server_sequence` breaks
 * ties because it is the total order the server already commits to.
 */
function findForks(database, vaultId) {
  const rows = database
    .prepare(
      `SELECT fh.file_id AS fileId,
              fh.revision_id AS revisionId,
              r.accepted_at AS acceptedAt,
              r.server_sequence AS serverSequence,
              r.blob_hash AS blobHash,
              f.vault_id AS vaultId
         FROM file_heads fh
         JOIN revisions r ON r.id = fh.revision_id
         JOIN files f ON f.id = fh.file_id
        ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}
        ORDER BY fh.file_id, r.accepted_at DESC, r.server_sequence DESC`,
    )
    .all(...(vaultId === null ? [] : [vaultId]));

  const byFile = new Map();
  for (const row of rows) {
    const heads = byFile.get(row.fileId);
    if (heads === undefined) byFile.set(row.fileId, [row]);
    else heads.push(row);
  }

  const forks = [];
  for (const [fileId, heads] of byFile) {
    if (heads.length < 2) continue;
    const distinctBlobs = new Set(heads.map((head) => head.blobHash));
    forks.push({
      fileId,
      heads,
      // Already sorted newest-first by the query.
      winner: heads[0],
      losers: heads.slice(1),
      identical: distinctBlobs.size === 1,
      versions: distinctBlobs.size,
    });
  }
  return forks;
}

function resolveForks(database, forks) {
  const drop = database.prepare(
    `DELETE FROM file_heads WHERE file_id = ? AND revision_id = ?`,
  );
  const run = database.transaction(() => {
    let dropped = 0;
    for (const fork of forks) {
      for (const loser of fork.losers) {
        drop.run(fork.fileId, loser.revisionId);
        dropped += 1;
      }
    }
    return dropped;
  });
  return run();
}

/**
 * Fails loudly unless the vault is in the state this run promised.
 *
 * `expectAllSingle` is false for `--identical-only`, which deliberately leaves
 * genuinely divergent forks for a human: there, the check that matters is only
 * that nothing was left headless.
 */
function verifySingleHeads(database, vaultId, expectAllSingle) {
  const remaining = expectAllSingle
    ? database
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT fh.file_id
           FROM file_heads fh
           JOIN files f ON f.id = fh.file_id
          ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}
          GROUP BY fh.file_id
         HAVING COUNT(*) > 1)`,
      )
      .get(...(vaultId === null ? [] : [vaultId])).count
    : 0;
  if (remaining > 0) {
    throw new Error(`${remaining} file(s) still hold more than one head.`);
  }
  // Every file that has any revision must still point at one, or the vault
  // would serve a file with no current content.
  const headless = database
    .prepare(
      `SELECT COUNT(*) AS count
         FROM files f
        WHERE EXISTS (SELECT 1 FROM revisions r WHERE r.file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM file_heads fh WHERE fh.file_id = f.id)
          ${vaultId === null ? '' : 'AND f.vault_id = ?'}`,
    )
    .get(...(vaultId === null ? [] : [vaultId])).count;
  if (headless > 0) {
    throw new Error(`${headless} file(s) were left without a head.`);
  }
}

function main() {
  const { databasePath, vaultId, apply, identicalOnly } = parseArgs(
    process.argv.slice(2),
  );
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const allForks = findForks(database, vaultId);
  const identical = allForks.filter((fork) => fork.identical);
  const divergent = allForks.filter((fork) => !fork.identical);

  console.log(`forked files: ${allForks.length}`);
  console.log(`  identical content (safe, nothing to choose): ${identical.length}`);
  console.log(`  genuinely different versions:                ${divergent.length}`);

  for (const fork of divergent.slice(0, 10)) {
    console.log(
      `    ${fork.fileId.slice(0, 8)}  heads=${fork.heads.length}  versions=${fork.versions}  keeping ${fork.winner.acceptedAt}`,
    );
  }
  if (divergent.length > 10) {
    console.log(`    ... and ${divergent.length - 10} more`);
  }

  const targets = identicalOnly ? identical : allForks;
  if (targets.length === 0) {
    console.log('\nNothing to resolve.');
    return;
  }

  if (!apply) {
    const losers = targets.reduce((sum, fork) => sum + fork.losers.length, 0);
    console.log(
      `\nDry run. Would drop ${losers} superseded head row(s) across ${targets.length} file(s).`,
    );
    console.log('Revisions, blobs and events are never deleted, only the head pointer moves.');
    console.log('Re-run with --apply (after a backup) to perform it.');
    return;
  }

  const dropped = resolveForks(database, targets);
  console.log(`\nresolved ${targets.length} file(s), dropped ${dropped} head row(s).`);
  verifySingleHeads(database, vaultId, !identicalOnly);
  console.log(
    identicalOnly
      ? `Verified: no file left headless. ${divergent.length} divergent fork(s) deliberately untouched.`
      : 'Verified: every file holds exactly one head, none left headless.',
  );
}

main();
