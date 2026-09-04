/**
 * The chooser and the host path (design 1d, plans/007 Phase B).
 *
 * Stacked rows, not side-by-side cards: at 300px each card is 140px and both
 * titles wrap, which is how you turn a two-word choice into a puzzle. Stacked,
 * each row gets a full line for its title and a second for its price.
 */

import { setIcon } from 'obsidian';

import type {
  EntryChooserViewModel,
  EntryChoice,
  HostViewModel,
} from '../runtime/entry-choice';

import { DECORATIVE } from './primitives';

export interface EntryChooserOptions {
  readonly model: EntryChooserViewModel;
  readonly onChoose: (choice: Exclude<EntryChoice, 'undecided'>) => void;
}

export function renderEntryChooser(
  content: HTMLElement,
  options: EntryChooserOptions,
): void {
  const { model } = options;

  const head = content.createDiv();
  head.addClass('havemind-entry-head');
  const mark = head.createEl('span', { attr: DECORATIVE });
  mark.addClass('havemind-pane-mark');
  setIcon(mark, 'hexagon');
  head.createEl('span', { text: model.heading, cls: 'havemind-pane-title' });

  content
    .createDiv({ text: model.subheading })
    .addClass('havemind-entry-subheading');
  content.createDiv({ text: model.question }).addClass('havemind-hint');

  // The pane becomes its own scroll box on this screen: there is no tab body
  // to scroll, and without it the last line sat flush on the pane's edge.
  content.addClass('havemind-view-scrolls');

  const list = content.createDiv();
  list.addClass('havemind-entry-options');
  for (const option of model.options) {
    const row = list.createEl('button');
    row.addClass('havemind-entry-option');
    row
      .createDiv({ text: option.title })
      .addClass('havemind-entry-option-title');
    // The cost sits on its own line so a wrong pick is visibly expensive
    // *before* it is made, not after fifteen minutes in a terminal.
    row.createDiv({ text: option.cost }).addClass('havemind-hint');
    row.onClickEvent(() => options.onChoose(option.id));
  }

  content.createDiv({ text: model.footnote }).addClass('havemind-hint');
}

export interface HostPathOptions {
  readonly model: HostViewModel;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onOpenGuide: (url: string) => void;
}

export function renderHostPath(
  content: HTMLElement,
  options: HostPathOptions,
): void {
  const { model } = options;

  const back = content.createEl('button', { text: 'Back' });
  back.addClass('havemind-entry-back');
  back.onClickEvent(() => options.onBack());

  content.createEl('h4', { text: model.heading });
  content
    .createDiv({ text: model.subheading })
    .addClass('havemind-entry-subheading');

  content.addClass('havemind-view-scrolls');

  const list = content.createDiv();
  list.addClass('havemind-host-steps');
  model.steps.forEach((step, index) => {
    const row = list.createDiv();
    row.addClass('havemind-step');
    const badge = row.createEl('span', { text: String(index + 1) });
    badge.addClass('havemind-step-number');
    const body = row.createDiv();
    body.addClass('havemind-step-text');
    body.createEl('span', { text: step.text });
    if (step.command !== undefined) {
      // A command the user must type is rendered as code, not prose: prose
      // invites paraphrase, and a paraphrased docker command does not run.
      body.createEl('code', {
        text: step.command,
        cls: 'havemind-host-command',
      });
    }
  });

  const guide = content.createEl('a', {
    text: model.guideLabel,
    attr: { href: model.guideUrl, target: '_blank', rel: 'noopener' },
  });
  guide.addClass('havemind-step-link');
  guide.addClass('external-link');
  // A bare <a> inside a plugin view does not reliably reach the browser, which
  // left this link dead twice (1.1.2, 1.1.5). Open it explicitly.
  guide.addEventListener('click', (event: MouseEvent) => {
    event.preventDefault();
    options.onOpenGuide(model.guideUrl);
  });

  const primary = content.createEl('button', { text: model.primaryAction });
  primary.addClass('mod-cta');
  primary.addClass('havemind-entry-primary');
  primary.onClickEvent(() => options.onContinue());
}
