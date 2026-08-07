#!/usr/bin/env node
// Operator-facing Havemind setup/diagnostics CLI.
//
// Thin process wrapper around the pure `runCli` in dist/setup/cli.js:
//   havemind setup --owner <name> --vault <name>
//   havemind rotate-pairing
//   havemind create-invitation [--role <role>] [--name <name>]
//   havemind approve [--invitation <id>] [--phrase <phrase>]
//   havemind generate-db-key
//   havemind doctor [--json]
//
//   havemind backup [--to <dir>] [--keep <n>]
//   havemind backup verify --from <dir>
//   havemind backup restore --from <dir> --to <dir>
//
//   havemind checkpoint generate-keypair
//   havemind checkpoint create [--keep <n>]
//   havemind checkpoint restore --from <dir> --to <dir> --secret-key-file <path>
//
// All command logic (and its tests) live in src/setup/cli.ts,
// src/backup-cli.ts and src/checkpoint-cli.ts. This file only wires the pure
// result to stdout/stderr and the process exit code. The `backup` and
// `checkpoint` subtrees are async (filesystem I/O, libsodium WASM), so they are
// dispatched to their async CLI runners.
import { runCli } from '../dist/setup/cli.js';

function emit(result) {
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== '') {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}

const argv = process.argv.slice(2);
if (argv[0] === 'backup') {
  const { runBackupCli } = await import('../dist/backup-cli.js');
  emit(await runBackupCli(argv.slice(1), { env: process.env }));
} else if (argv[0] === 'checkpoint') {
  const { runCheckpointCli } = await import('../dist/checkpoint-cli.js');
  emit(await runCheckpointCli(argv.slice(1), { env: process.env }));
} else {
  emit(runCli(argv, { env: process.env }));
}
