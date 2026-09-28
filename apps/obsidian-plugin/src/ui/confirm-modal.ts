/**
 * A yes/no confirmation for a destructive action that has no undo. The panel
 * menu, the settings tab and the command palette all reach Reset connection
 * with one tap, so the confirmation lives here rather than in any one of them.
 * No `window.confirm`: it blocks Electron and does not exist on mobile.
 */

import { Modal, type App } from 'obsidian';

export interface ConfirmModalOptions {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  private readonly options: ConfirmModalOptions;

  constructor(app: App, options: ConfirmModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.options.title });
    contentEl.createEl('p', { text: this.options.body });
    const buttons = contentEl.createDiv();
    buttons.addClass('modal-button-container');
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.onClickEvent(() => this.close());
    const confirm = buttons.createEl('button', { text: this.options.confirmLabel });
    confirm.addClass('mod-warning');
    confirm.onClickEvent(() => {
      this.close();
      this.options.onConfirm();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
