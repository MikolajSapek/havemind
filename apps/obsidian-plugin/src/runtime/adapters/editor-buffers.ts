import type { MarkdownView, Workspace } from 'obsidian';
import { canonicalizeMarkdown } from '@havemind/protocol';

/** Include background leaves and popout windows, not only the active editor. */
export function editorTexts(workspace: Pick<Workspace, 'iterateAllLeaves'> | undefined, path: string): string[] {
  const texts: string[] = [];
  workspace?.iterateAllLeaves((leaf) => {
    if (leaf.view.getViewType() !== 'markdown') return;
    const view = leaf.view as MarkdownView;
    // Reading view has no editable buffer. Deferred leaves may have no file yet.
    if (view.file?.path === path && view.getMode() === 'source') {
      texts.push(canonicalizeMarkdown(view.editor.getValue()));
    }
  });
  return texts;
}
