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
// All command logic (and its tests) live in src/setup/cli.ts. This file only
// wires the pure result to stdout/stderr and the process exit code.
import { runCli } from '../dist/setup/cli.js';

const result = runCli(process.argv.slice(2), { env: process.env });
if (result.stdout !== '') {
  process.stdout.write(result.stdout);
}
if (result.stderr !== '') {
  process.stderr.write(result.stderr);
}
process.exit(result.exitCode);
