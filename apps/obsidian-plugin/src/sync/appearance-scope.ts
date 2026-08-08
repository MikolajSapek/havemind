/**
 * `.obsidian/` APPEARANCE scope predicate for the plugin: an EXPLICIT ALLOWLIST
 * of safe appearance settings (`appearance.json`, `app.json`, `hotkeys.json`,
 * `core-plugins.json`, `snippets/<name>.css`, `themes/<name>/…`). Everything
 * else under `.obsidian/` stays on the machine — above all
 * `.obsidian/plugins/**`, whose code a peer must never be able to overwrite
 * (audit #3 finding 2: that was remote code execution between vault members).
 *
 * The implementation is the single source of truth in `@havemind/protocol`,
 * because the same allowlist governs both this producer-side guard AND the
 * protocol's `canonicalizeVaultPath` (envelope build, wire-schema refinement and
 * consumer decode). Re-exporting keeps one list — a security boundary that must
 * never drift between producer and consumer — while preserving this module path
 * as the plugin's stable import site.
 */
export { isSyncableConfigPath } from '@havemind/protocol';
