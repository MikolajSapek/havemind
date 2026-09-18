#!/usr/bin/env node
/**
 * Retire duplicate files: same content, two identities.
 *
 * WHY THIS EXISTS
 *
 * A device joining a vault that is still filling sees nothing on the server yet
 * and pushes its own copy of every note it holds. The vault then carries the
 * same text twice under two file ids. On the pilot's second vault that made 117
 * files out of 86 distinct contents: the desktop uploaded first (low sequence
 * numbers) and the phone re-uploaded the identical bytes minutes later.
 *
 * The client-side fix is `join-adoption.ts`, which settles identity by content
 * at join time. This script repairs a vault duplicated before that landed.
 *
 * WHAT THIS DOES
 *
 * Groups files by the content hash of their current head. Where several files
 * share one content, the EARLIEST (lowest server sequence, i.e. the original
 * upload) is kept and the later copies are retired by dropping their head rows.
 *
 * Nothing is deleted beyond those rows: every revision, blob, event and parent
 * link stays exactly as it is. A retired file simply stops being current, so
 * clients stop materialising a second copy of the same note.
 *
 * ONLY byte-identical content is ever merged. A file whose head content differs
 * from every other is never touched, whatever its name.
 *
 * USAGE
 *   node merge-duplicate-files.mjs <database-path> [--vault <id>] [--apply]
 *
 * Without `--apply` it reports and changes nothing. Take a backup first.
 */

import Database from 'better-sqlite3';

function parseArgs(argv) {
  const [databasePath, ...rest] = argv;
  if (databasePath === undefined) {
    throw new Error(
      'Usage: node merge-duplicate-files.mjs <database-path> [--vault <id>] [--apply]',
    );
  }
  let vaultId = null;
  let apply = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--apply') apply = true;
    else if (flag === '--vault') {
      vaultId = rest[index + 1] ?? null;
      index += 1;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return { databasePath, vaultId, apply };
}

/**
 * Files grouped by the content of their CURRENT head, keeping only groups where
 * more than one file holds the same bytes.
 *
 * Only current heads count: an old revision that happened to share content with
 * another file is history, not a duplicate.
 */
function findDuplicateGroups(database, vaultId) {
  const rows = database
    .prepare(
      `SELECT fh.file_id AS fileId,
              r.blob_hash AS blobHash,
              r.server_sequence AS serverSequence,
              r.device_id AS deviceId
         FROM file_heads fh
         JOIN revisions r ON r.id = fh.revision_id
         JOIN files f ON f.id = fh.file_id
        ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}
        ORDER BY r.blob_hash, r.server_sequence`,
    )
    .all(...(vaultId === null ? [] : [vaultId]));

  const byContent = new Map();
  for (const row of rows) {
    const group = byContent.get(row.blobHash);
    if (group === undefined) byContent.set(row.blobHash, [row]);
    else group.push(row);
  }

  const groups = [];
  for (const [blobHash, files] of byContent) {
    if (files.length < 2) continue;
    // Sorted by sequence already: the first upload is the original.
    groups.push({ blobHash, keep: files[0], retire: files.slice(1) });
  }
  return groups;
}

function retireDuplicates(database, groups) {
  const dropHead = database.prepare(
    `DELETE FROM file_heads WHERE file_id = ?`,
  );
  const run = database.transaction(() => {
    let retired = 0;
    for (const group of groups) {
      for (const file of group.retire) {
        dropHead.run(file.fileId);
        retired += 1;
      }
    }
    return retired;
  });
  return run();
}

/** Fails loudly unless the vault is left in the state this run promised. */
function verify(database, vaultId, expectedDistinct) {
  const current = database
    .prepare(
      `SELECT COUNT(*) AS count FROM file_heads fh
         JOIN files f ON f.id = fh.file_id
        ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}`,
    )
    .get(...(vaultId === null ? [] : [vaultId])).count;
  if (current !== expectedDistinct) {
    throw new Error(
      `expected ${expectedDistinct} current file(s) after the merge, found ${current}.`,
    );
  }
  const stillDuplicated = database
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT r.blob_hash
           FROM file_heads fh
           JOIN revisions r ON r.id = fh.revision_id
           JOIN files f ON f.id = fh.file_id
          ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}
          GROUP BY r.blob_hash
         HAVING COUNT(*) > 1)`,
    )
    .get(...(vaultId === null ? [] : [vaultId])).count;
  if (stillDuplicated > 0) {
    throw new Error(`${stillDuplicated} content(s) still have several current files.`);
  }
}

function main() {
  const { databasePath, vaultId, apply } = parseArgs(process.argv.slice(2));
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');

  const groups = findDuplicateGroups(database, vaultId);
  const totalCurrent = database
    .prepare(
      `SELECT COUNT(*) AS count FROM file_heads fh
         JOIN files f ON f.id = fh.file_id
        ${vaultId === null ? '' : 'WHERE f.vault_id = ?'}`,
    )
    .get(...(vaultId === null ? [] : [vaultId])).count;

  const toRetire = groups.reduce((sum, group) => sum + group.retire.length, 0);
  console.log(`current files:        ${totalCurrent}`);
  console.log(`duplicated contents:  ${groups.length}`);
  console.log(`copies to retire:     ${toRetire}`);

  for (const group of groups.slice(0, 8)) {
    const keptFrom = group.keep.deviceId.slice(0, 8);
    const copies = group.retire
      .map((file) => `${file.fileId.slice(0, 8)}@${file.deviceId.slice(0, 8)}`)
      .join(', ');
    console.log(
      `  ${group.blobHash.slice(0, 8)}  keep ${group.keep.fileId.slice(0, 8)} (seq ${group.keep.serverSequence}, ${keptFrom})  retire ${copies}`,
    );
  }
  if (groups.length > 8) console.log(`  ... and ${groups.length - 8} more`);

  if (groups.length === 0) {
    console.log('\nNothing to merge: every current file holds distinct content.');
    return;
  }

  if (!apply) {
    console.log(
      `\nDry run. Would retire ${toRetire} duplicate file(s), leaving ${totalCurrent - toRetire}.`,
    );
    console.log('Revisions, blobs and events are never deleted, only the head pointer drops.');
    console.log('Re-run with --apply (after a backup) to perform it.');
    return;
  }

  const retired = retireDuplicates(database, groups);
  console.log(`\nretired ${retired} duplicate file(s).`);
  verify(database, vaultId, totalCurrent - toRetire);
  console.log(
    `Verified: ${totalCurrent - toRetire} current file(s), each with distinct content.`,
  );
}

main();
