/**
 * `.obsidian/` config MIRROR scope predicate for the plugin: everything under
 * `.obsidian/` syncs EXCEPT a hard denylist (secrets `data.json`, per-machine
 * `workspace.json`, the enabled-plugins list, and our own plugin folder).
 *
 * The implementation is the single source of truth in `@havemind/protocol`,
 * because the same mirror/denylist governs both this producer-side guard AND the
 * protocol's `canonicalizeVaultPath` (envelope build, wire-schema refinement and
 * consumer decode). Re-exporting keeps one list — a security boundary that must
 * never drift between producer and consumer — while preserving this module path
 * as the plugin's stable import site.
 */
export { isSyncableConfigPath } from '@havemind/protocol';
