/**
 * The chooser and the host path (design 1d, plans/007 Phase B).
 *
 * Stacked rows, not side-by-side cards: at 300px each card is 140px and both
 * titles wrap, which is how you turn a two-word choice into a puzzle. Stacked,
 * each row gets a full line for its title and a second for its price.
 */

import type {
  EntryChooserViewModel,
  EntryChoice,
  HostViewModel,
} from '../runtime/entry-choice';

import { buildFlowerModel } from '../runtime/flower-model';

import { renderFlower } from './flower';

export interface EntryChooserOptions {
  readonly model: EntryChooserViewModel;
  readonly onChoose: (choice: Exclude<EntryChoice, 'undecided'>) => void;
}

export function renderEntryChooser(
  content: HTMLElement,
  options: EntryChooserOptions,
): void {
  const { model } = options;
  // The empty flower: no server yet, this device waiting for a seat (plan 010).
  const head = content.createDiv();
  head.addClass('havemind-entry-head');
  renderFlower(head, buildFlowerModel({ members: [], status: 'disconnected' }));
  content.createDiv({ text: model.subheading }).addClass('havemind-entry-title');

  // The pane becomes its own scroll box on this screen: there is no tab body
  // to scroll, and without it the last line sat flush on the pane's edge.
  content.addClass('havemind-view-scrolls');

  // One primary way in, the other as a quieter text button. The hosting path
  // shows its cost on the next screen, where it can be read in full.
  const list = content.createDiv();
  list.addClass('havemind-entry-options');
  model.options.forEach((option, index) => {
    const row = list.createEl('button', { text: option.title });
    row.addClass('havemind-entry-option');
    if (index === 0) row.addClass('mod-cta');
    row.onClickEvent(() => options.onChoose(option.id));
  });

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

  content.createDiv({ text: model.heading }).addClass('havemind-entry-title');
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
