/**
 * The pane's tab strip.
 *
 * One sidebar, one row of tabs, and clicking a tab switches what the body
 * shows. Everything the plugin offers is reachable from here without opening a
 * second surface.
 *
 * The one rule this model enforces: **a tab may hide content, never an alarm.**
 * The designer's objection to tabs was that a pane can read "Synced" while two
 * files sit in conflict one tab away, with only a 6px dot arguing otherwise —
 * which would quietly break the promise the whole product rests on. So a tab
 * carrying something that needs the user reports it here, the strip marks it,
 * and the pane renders the alarm above the strip regardless of which tab is
 * open. Tabs organise; they do not conceal.
 *
 * Pure: no DOM, no Obsidian import.
 */

export type PaneTabId = 'status' | 'activity' | 'people';

export interface PaneTab {
  readonly id: PaneTabId;
  /** Short enough to survive a 300px strip without truncating. */
  readonly label: string;
  /** Lucide icon name. */
  readonly icon: string;
  /** Count shown beside the label, when the tab has one. */
  readonly count?: number;
  /**
   * True when this tab holds something the user must act on. The strip marks
   * it, but the pane also lifts the item above the strip — a mark alone is the
   * failure mode we are avoiding, not the fix.
   */
  readonly needsAttention?: boolean;
}

export interface PaneTabsInput {
  readonly active: PaneTabId;
  readonly activityCount: number;
  readonly peopleCount: number;
  /** Conflicts and failed sends live under Status and demand attention. */
  readonly attentionCount: number;
}

export interface PaneTabsView {
  readonly tabs: readonly PaneTab[];
  readonly active: PaneTabId;
}

export function buildPaneTabs(input: PaneTabsInput): PaneTabsView {
  const tabs: PaneTab[] = [
    {
      id: 'status',
      label: 'Status',
      icon: 'activity',
      ...(input.attentionCount > 0
        ? { count: input.attentionCount, needsAttention: true }
        : {}),
    },
    {
      id: 'activity',
      label: 'Activity',
      icon: 'history',
      ...(input.activityCount > 0 ? { count: input.activityCount } : {}),
    },
    {
      id: 'people',
      label: 'People',
      icon: 'users',
      ...(input.peopleCount > 0 ? { count: input.peopleCount } : {}),
    },
  ];

  // Three tabs for everyone. Inviting used to be a fourth, owner-only tab —
  // which made the strip change shape by role, so the pane became two
  // structurally different products to describe, screenshot and support. It is
  // a modal launched from People now: a momentary task should not hold a
  // permanent slot in the most valuable strip of pixels in the plugin.
  const active = tabs.some((tab) => tab.id === input.active)
    ? input.active
    : 'status';

  return { tabs, active };
}
