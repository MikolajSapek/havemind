/**
 * The two Obsidian view type ids Havemind registers. They live in their own
 * module because the plugin entry point, the Activity view and the onboarding
 * view all need them: keeping the string constants here lets the view classes be
 * imported by `main.ts` without any of them importing `main.ts` back, so the
 * `ui/` layer stays free of import cycles. The literal values are part of the
 * persisted workspace layout and must never change.
 */

export const HAVEMIND_ACTIVITY_VIEW = 'havemind-activity';
export const HAVEMIND_ONBOARDING_VIEW = 'havemind-onboarding';
