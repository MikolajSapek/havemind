/**
 * Copy-to-clipboard helper for the owner "Create invitation" panel (F8-02d gap
 * 1). The invitation envelope is a secret, so this helper only moves the text
 * into the clipboard and never logs it. The async `navigator.clipboard` path is
 * preferred; a manual `document.execCommand('copy')` fallback (via
 * `browserClipboardCopyDeps`) covers older/denied contexts, and the panel always
 * keeps a readonly field so the owner can select the text by hand if both fail.
 */

export interface ClipboardCopyDeps {
  /** Async clipboard, when the host exposes `navigator.clipboard`. */
  readonly clipboard?: { writeText(text: string): Promise<void> } | undefined;
  /** Synchronous fallback (e.g. `document.execCommand('copy')`). */
  readonly fallbackCopy?: (text: string) => boolean;
}

/** Copies `text`; returns whether any path succeeded. Never logs `text`. */
export async function copyTextToClipboard(
  text: string,
  deps: ClipboardCopyDeps,
): Promise<boolean> {
  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the manual fallback below.
    }
  }
  if (deps.fallbackCopy) {
    try {
      return deps.fallbackCopy(text);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Wires the real browser clipboard APIs. Kept out of the pure helper so the copy
 * logic stays unit-testable; this factory is exercised only in the live pilot.
 */
export function browserClipboardCopyDeps(): ClipboardCopyDeps {
  return {
    clipboard:
      typeof navigator !== 'undefined' && navigator.clipboard
        ? navigator.clipboard
        : undefined,
    fallbackCopy: (text) => {
      if (typeof document === 'undefined') return false;
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', 'true');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      // The ambient `obsidian.d.ts` augments the global `HTMLElement` interface
      // (adding `value`/`createEl`), which under `exactOptionalPropertyTypes`
      // poisons `HTMLElementTagNameMap` and makes `HTMLTextAreaElement` fail to
      // structurally match `Node` for `appendChild`/`removeChild`. `field` is a
      // real DOM node at runtime, so this cast is safe.
      const node = field as unknown as Node;
      document.body.appendChild(node);
      field.select();
      let copied: boolean;
      try {
        copied = document.execCommand('copy');
      } finally {
        document.body.removeChild(node);
      }
      return copied;
    },
  };
}
