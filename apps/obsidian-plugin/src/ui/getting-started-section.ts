/**
 * The in-plugin "Getting started" tutorial section. It is the one surface a user
 * with no connection sees first, and the same markup is re-used behind the
 * connected panel's collapsed help toggle, so it lives on its own rather than
 * inside either view. All wording, ordering and the doc link come from the pure
 * `buildGettingStartedViewModel` helper in `runtime/`; this module only maps that
 * data onto the panel's list-and-hint visual language and wires to no backend call.
 */

import type { GettingStartedViewModel } from '../runtime/getting-started-render';

/**
 * Renders the in-plugin "Getting started" tutorial: a small heading, the
 * numbered single-line steps (each with an accent number badge), and a closing
 * footnote. Content comes from the pure `buildGettingStartedViewModel` helper so
 * the wording, ordering and doc link stay unit-tested; this function only maps
 * that data onto the panel's existing list-and-hint visual language. Presentation
 * only, it wires to no backend call.
 */
export function renderGettingStarted(
  content: HTMLElement,
  model: GettingStartedViewModel,
): void {
  const wrap = content.createDiv();
  wrap.addClass('havemind-getting-started');
  wrap.createEl('h4', { text: model.title });
  wrap
    .createDiv({ text: model.requirement })
    .addClass('havemind-getting-started-requirement');
  for (const step of model.steps) {
    const row = wrap.createDiv();
    row.addClass('havemind-step');
    const badge = row.createEl('span', { text: String(step.number) });
    badge.addClass('havemind-step-number');
    const body = row.createDiv();
    body.addClass('havemind-step-text');
    body.createEl('span', { text: step.text });
    if (step.docRef) {
      body.createEl('span', { text: ' ' });
      const url = step.docRef.url;
      const link = body.createEl('a', {
        text: step.docRef.label,
        // `external-link` is what Obsidian's own click handling keys on; without
        // it a bare href inside a plugin view is inert. `target`/`rel` keep the
        // element correct as plain HTML too.
        attr: { href: url, target: '_blank', rel: 'noopener' },
      });
      link.addClass('havemind-step-link');
      link.addClass('external-link');
      // Do not rely on default navigation: an <a> inside a plugin view does not
      // reliably reach the OS browser across Obsidian versions, which left this
      // link doing nothing at all when clicked. Open it explicitly instead.
      link.addEventListener('click', (event: MouseEvent) => {
        event.preventDefault();
        window.open(url, '_blank');
      });
    }
  }
  wrap.createDiv({ text: model.footnote }).addClass('havemind-hint');
}
