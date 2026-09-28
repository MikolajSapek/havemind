/**
 * The Obsidian view type id Havemind registers. It lives in its own module so
 * the view class can be imported by `main.ts` without importing `main.ts`
 * back, keeping the `ui/` layer free of import cycles. The literal value is
 * part of the persisted workspace layout and must never change.
 */

export const HAVEMIND_ONBOARDING_VIEW = 'havemind-onboarding';
