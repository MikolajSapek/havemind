/**
 * What a repaint must not take from the user: the field they are typing in
 * (and its caret) and how far they have scrolled the open tab.
 *
 * The pane rebuilds its whole DOM on every status change. Without this the
 * focused field is destroyed, so a phone's keyboard closes mid-code, and the
 * tab body (the scroller) comes back at the top. Focus is matched by element
 * id, scroll by tab: another tab starts at the top, as a new page would.
 */

import type { PaneTabId } from '../../runtime/pane-tabs';

const TAB_BODY = '.havemind-tab-body';

export interface PaneViewport {
  readonly focusId?: string;
  readonly selection?: { readonly start: number | null; readonly end: number | null };
  readonly tab: PaneTabId;
  readonly scrollTop: number;
}

type Field = HTMLInputElement;

/** Reads focus, caret and scroll; call before the DOM is torn down. */
export function captureViewport(content: HTMLElement, tab: PaneTabId): PaneViewport {
  const scrollTop = (content.querySelector(TAB_BODY) as HTMLElement | null)?.scrollTop ?? 0;
  const active = content.ownerDocument?.activeElement as unknown as Field | null | undefined;
  if (active == null || !content.contains(active as unknown as Node) || !active.getAttribute('id')) return { tab, scrollTop };
  return {
    tab,
    scrollTop,
    focusId: active.getAttribute('id') ?? '',
    selection: { start: active.selectionStart ?? null, end: active.selectionEnd ?? null },
  };
}

/** Puts them back after the rebuild, when the same tab and field exist again. */
export function restoreViewport(content: HTMLElement, saved: PaneViewport, tab: PaneTabId): void {
  const body = content.querySelector(TAB_BODY) as HTMLElement | null;
  if (body !== null && saved.tab === tab && saved.scrollTop > 0) body.scrollTop = saved.scrollTop;

  if (saved.focusId === undefined) return;
  // A render that already moved focus (a keyboard tab selection) wins.
  const current = content.ownerDocument?.activeElement as unknown as Field | null | undefined;
  if (current != null && content.contains(current as unknown as Node)) return;
  const field = content.querySelector(`#${saved.focusId}`) as unknown as Field | null;
  if (field === null) return;
  // Without this the page scrolls to reveal the field, undoing the restore above.
  field.focus({ preventScroll: true });
  const { start, end } = saved.selection ?? { start: null, end: null };
  if (start === null || end === null) return;
  try {
    field.setSelectionRange(start, end);
  } catch {
    // Types without a caret (checkbox, number) refuse; focus alone is right.
  }
}
