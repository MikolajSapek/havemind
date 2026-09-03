/**
 * The disconnected pane: ask which path the user is on, then show only the
 * branch they picked.
 *
 * The five-step tutorial used to render unconditionally above the form, correct
 * for the half of users who will host a server and fatal for the half who only
 * need to paste an invitation someone sent them. The chooser is skipped for
 * anyone who has self-evidently already answered: a typed token, an arrival
 * through a join link, or an owner who opened the composer.
 *
 * Extracted from `onboarding-view.ts` for Stage 3. The entry choice stays owned
 * by the caller, because it has to survive the repaint this triggers.
 */

import {
  buildEntryChooser,
  buildHostView,
  type EntryChoice,
} from '../../runtime/entry-choice';
import { renderEntryChooser, renderHostPath } from '../entry-chooser-section';

export interface EntryPathState {
  readonly entryChoice: EntryChoice;
  /** True when a token is typed or a join link brought them here. */
  readonly alreadyAnswered: boolean;
  readonly canHost: boolean;
}

export interface EntryPathActions {
  /** Records the picked path and repaints. */
  readonly onChoose: (choice: EntryChoice) => void;
  /** Draws the paste form, which the caller owns (it holds the draft). */
  readonly renderForm: (content: HTMLElement) => void;
  readonly onOpenGuide?: ((url: string) => void) | undefined;
}

export function renderEntryPath(
  content: HTMLElement,
  state: EntryPathState,
  actions: EntryPathActions,
): void {
  const decided = state.entryChoice !== 'undecided' || state.alreadyAnswered;

  if (!decided) {
    renderEntryChooser(content, {
      model: buildEntryChooser({ canHost: state.canHost }),
      onChoose: (choice) => actions.onChoose(choice),
    });
    return;
  }

  if (state.entryChoice === 'hosting') {
    renderHostPath(content, {
      model: buildHostView(),
      onBack: () => actions.onChoose('undecided'),
      onContinue: () => actions.onChoose('joining'),
      onOpenGuide: (url: string) => actions.onOpenGuide?.(url),
    });
    return;
  }

  // The joining path: three fields and one button, with no tutorial above it.
  const back = content.createEl('button', { text: 'Back' });
  back.addClass('havemind-entry-back');
  back.onClickEvent(() => actions.onChoose('undecided'));
  actions.renderForm(content);
}
