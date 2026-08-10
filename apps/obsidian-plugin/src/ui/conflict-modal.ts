/**
 * The MRG-03 in-app diff/merge modal for a single conflict copy: the pure model
 * built from a copy plus its computed diff, the body renderer, and the thin
 * `Modal` subclass that hosts them. The three resolution choices are destructive,
 * so two of them are two-step confirms and "Keep theirs" is offered only when a
 * text target actually exists. The model is separated from the modal so the
 * wording and button gating stay unit-testable without an Obsidian `App`.
 */

import { Modal, type App } from 'obsidian';

import type { ConflictCopy, DiffLine } from '../runtime/conflict-resolution';

import { armedButton, renderViewTitle } from './primitives';

/** View model for the resolve modal — pure, built from a copy + optional diff. */
export interface ConflictModalModel {
  readonly title: string;
  readonly author: string | null;
  readonly timestamp: string | null;
  readonly isBinary: boolean;
  readonly targetKnown: boolean;
  /** Line diff (note vs copy), or null for binary/unknown-target copies. */
  readonly diff: readonly DiffLine[] | null;
  readonly manualHint: string | null;
}

/** Builds the modal model from a conflict copy and its computed diff (if any). */
export function buildConflictModalModel(
  copy: ConflictCopy,
  diff: readonly DiffLine[] | null,
): ConflictModalModel {
  return {
    title: copy.noteName ?? copy.copyName,
    author: copy.author,
    timestamp: copy.timestamp,
    isBinary: copy.isBinary,
    targetKnown: copy.targetKnown,
    diff,
    manualHint: copy.manualHint,
  };
}

/** Callbacks wired to the resolve modal's three buttons. */
export interface ConflictModalActions {
  /** Keep the live note, discard the copy (destructive → two-step confirm). */
  readonly onKeepMine?: () => void;
  /** Overwrite the note with the copy (destructive → two-step confirm). */
  readonly onKeepTheirs?: () => void;
  /** Leave both files in place and close the modal. */
  readonly onKeepBoth: () => void;
}

/**
 * Renders the resolve modal body: a heading, the manual hint (if any), the
 * colour-coded line diff (added lines tinted with --text-success, removed with
 * --text-error), and the three resolution buttons. "Keep theirs" is offered
 * only when a text target is known — a missing target or a binary copy cannot be
 * written from here, so those resolve by keeping mine or opening files manually.
 */
export function renderConflictModalBody(
  container: HTMLElement,
  model: ConflictModalModel,
  actions: ConflictModalActions,
): void {
  container.addClass('havemind-conflict-modal');
  renderViewTitle(container, `Resolve conflict — ${model.title}`);

  if (model.author !== null && model.timestamp !== null) {
    const meta = container.createDiv({
      text: `Conflict from ${model.author} · ${model.timestamp}`,
    });
    meta.addClass('havemind-conflict-modal-meta');
  }

  if (model.manualHint !== null) {
    const hint = container.createDiv({ text: model.manualHint });
    hint.addClass('havemind-conflict-hint');
  }

  if (model.diff !== null) {
    const diffBox = container.createDiv({ text: '' });
    diffBox.addClass('havemind-conflict-diff');
    for (const line of model.diff) {
      const prefix =
        line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ';
      const row = diffBox.createDiv({ text: `${prefix}${line.text}` });
      row.addClass('havemind-conflict-line');
      row.addClass(`havemind-conflict-line-${line.type}`);
    }
  }

  const buttons = container.createDiv({ text: '' });
  buttons.addClass('havemind-conflict-buttons');

  if (actions.onKeepMine) {
    armedButton(
      buttons,
      'Keep mine',
      'Confirm keep mine',
      'mod-warning',
      actions.onKeepMine,
    );
  }
  if (actions.onKeepTheirs && model.targetKnown && !model.isBinary) {
    armedButton(
      buttons,
      'Keep theirs',
      'Confirm keep theirs',
      'mod-warning',
      actions.onKeepTheirs,
    );
  }
  const keepBoth = buttons.createEl('button', { text: 'Keep both (close)' });
  keepBoth.addClass('havemind-conflict-action');
  keepBoth.onClickEvent(() => actions.onKeepBoth());
}

/** The in-app diff/merge modal for a single conflict copy (livesync-style). */
export class ConflictResolveModal extends Modal {
  private readonly model: ConflictModalModel;
  private readonly actions: ConflictModalActions;

  constructor(app: App, model: ConflictModalModel, actions: ConflictModalActions) {
    super(app);
    this.model = model;
    this.actions = actions;
  }

  override onOpen(): void {
    renderConflictModalBody(this.contentEl, this.model, this.actions);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
