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

/** Compact local clock time for an activity row (e.g. "15:42"). */
export function formatActivityTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
 * A form field joined to its label by `for`/`id`.
 *
 * A `<label>` next to an `<input>` looks labelled and is not: they are two
 * unrelated elements, and a screen reader reaching the field announces "edit
 * text, blank" while the word sits beside it in the DOM. The pairing is what
 * gives the field a name, so it must never be left to visual proximity.
 *
 * `id` is passed in rather than generated: a stable id survives the pane's
 * frequent re-renders, and a generated one would change under any assistive
 * technology holding a reference to it.
 */
export function labelledField(
  parent: HTMLElement,
  id: string,
  label: string,
  tag: 'input' | 'textarea' | 'select',
  options: {
    readonly type?: string;
    readonly placeholder?: string;
    readonly value?: string;
  } = {},
): HTMLElement {
  parent.createEl('label', { text: label, attr: { for: id } });
  const field = parent.createEl(tag, {
    attr: { id },
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.placeholder !== undefined
      ? { placeholder: options.placeholder }
      : {}),
    ...(options.value !== undefined ? { value: options.value } : {}),
  });
  return field;
}

/**
 * The form's status line, as a live region.
 *
 * "Connecting…", "That code did not match", "Copied" — every one of these is
 * written into this element after the user acts. Without `role="status"` the
 * change is silent to a screen reader: the sighted user sees the result and
 * everyone else waits for nothing.
 *
 * `polite` rather than `assertive`, and never a focus move: the user is mid-form
 * when these fire, so an interruption would cost them their place for a message
 * that is only progress.
 */
export function renderFormStatus(parent: HTMLElement): HTMLElement {
  const status = parent.createDiv({ text: '' });
  status.addClass('havemind-form-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  return status;
}

/**
 * Wraps an alarm — a conflict list, a failed send — in the single bordered
 * region the design draws it as: accent rule down the left edge, tinted ground,
 * hairline closing it underneath.
 *
 * It exists because containment is load-bearing here rather than cosmetic.
 * Drawn as loose siblings (which is how this started) the tint stops short of
 * the heading, nothing closes the block off at the bottom, and the left rule
 * runs beside the rows only — three fragments where the design has one object.
 * No amount of correct spacing fixes that; the elements have to share a parent.
 *
 * Returns the block so the caller renders its contents inside, and takes the
 * caller's own class so conflicts and failed sends can still be told apart
 * while sharing one shape.
 */
export function renderAlarmBlock(
  content: HTMLElement,
  variant: string,
): HTMLElement {
  const block = content.createDiv();
  block.addClass('havemind-alarm');
  block.addClass(variant);
  return block;
}

/**
 * Read a provider without letting it take the pane down.
 *
 * `renderSection` guards the sections it wraps, but the view reads several
 * providers BEFORE any section exists — to decide which surface to draw at all.
 * `render()` has already called `content.empty()` by then, so a throw there left
 * the user with a blank pane: no header, no tabs, no way back. That is the
 * precise failure the boundaries exist to prevent, arriving by the one route
 * nothing guarded.
 *
 * Returns `fallback` when the provider throws, and names the provider in the
 * log so a silent degrade is still traceable.
 */
export function safeRead<T>(
  name: string,
  read: (() => T) | undefined,
  fallback: T,
): T {
  if (read === undefined) return fallback;
  try {
    return read();
  } catch (error) {
    console.error(`Havemind: the "${name}" provider failed`, error);
    return fallback;
  }
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
