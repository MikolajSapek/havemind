/**
 * The shared presentation primitives every Havemind surface is built from: the
 * decorative-glyph attributes, the panel title with its hive-hexagon accent, the
 * per-section error boundary, the destructive two-step confirm button, the
 * compact activity timestamp and the reduced-motion probe. They live together
 * because they encode panel-wide conventions (never colour alone, never
 * `window.confirm`, one failing section never blanks a pane) that the section
 * renderers, the view classes and the plugin's status bar must all obey
 * identically. Presentation only — nothing here reads or writes plugin state.
 */

import { setIcon } from 'obsidian';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Attributes for a glyph that carries no information of its own. Every Havemind
 * icon and colour dot sits beside its own word (the panel convention: never
 * colour alone), so assistive technology must skip the glyph rather than
 * announce an unnamed image next to the label that already says it.
 */
export const DECORATIVE = { 'aria-hidden': 'true' } as const;

/** Compact local time for an activity row (e.g. "16 Jul, 15:42"). */
export function formatActivityTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/**
 * Renders a panel's `h3` title with a small leading hexagon glyph — the
 * "hive mind" motif that gives every Havemind surface a shared identity. The
 * title text stays on the `h3` itself; the hexagon is an accent-tinted child
 * placed before the text via CSS (order), so it never becomes the only signal
 * and never changes the heading's text content.
 */
export function renderViewTitle(content: HTMLElement, text: string): void {
  const heading = content.createEl('h3', { text });
  heading.addClass('havemind-view-title');
  // Pure decoration: the heading already carries the title text, so a screen
  // reader must not announce the glyph as a second, unnamed thing.
  const icon = heading.createEl('span', { attr: DECORATIVE });
  icon.addClass('havemind-title-icon');
  setIcon(icon, 'hexagon');
}

/**
 * MAJOR 5: render one panel section inside an error boundary. A synchronous
 * throw from a section's provider or render body is logged and degraded to a
 * small inline "Section unavailable" fallback so the failure is contained to
 * that section — every other section keeps rendering rather than the whole
 * panel blanking after `content.empty()`.
 */
export function renderSection(
  content: HTMLElement,
  name: string,
  render: () => void,
): void {
  try {
    render();
  } catch (error) {
    console.error(`Havemind: the "${name}" panel section failed to render`, error);
    const fallback = content.createDiv({ text: 'Section unavailable' });
    fallback.addClass('havemind-section-error');
  }
}

/**
 * A destructive two-step confirm button, mirroring the Remove-button idiom: the
 * first click arms the button (swapping its label to `confirmLabel`), the second
 * click within the same render executes. `executed` guards a stray third click
 * from re-firing after confirmation. No `window.confirm` — it blocks Electron.
 */
export function armedButton(
  parent: HTMLElement,
  label: string,
  confirmLabel: string,
  cls: string,
  onConfirm: () => void,
): void {
  let armed = false;
  let executed = false;
  const button = parent.createEl('button', { text: label });
  button.addClass(cls);
  button.onClickEvent(() => {
    if (executed) return;
    if (!armed) {
      armed = true;
      button.setText(confirmLabel);
      button.addClass('havemind-conflict-action-armed');
      return;
    }
    executed = true;
    onConfirm();
  });
}
