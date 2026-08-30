/**
 * The slice of Obsidian's API the entry screens touch, on real browser DOM.
 *
 * The preview imports the *shipping* section renderers, so this shim exists to
 * let those files run outside Obsidian unchanged. It implements only what they
 * call. Anything else is deliberately absent: a preview that quietly grew its
 * own second implementation of a pane would stop being evidence about the pane.
 */

interface CreateElOptions {
  readonly text?: string;
  readonly cls?: string;
  readonly attr?: Record<string, string>;
}

declare global {
  interface HTMLElement {
    createDiv(options?: CreateElOptions): HTMLElement;
    createEl(tag: string, options?: CreateElOptions): HTMLElement;
    onClickEvent(callback: (event: MouseEvent) => void): void;
    addClass(name: string): void;
    empty(): void;
  }
}

function apply(element: HTMLElement, options?: CreateElOptions): HTMLElement {
  if (options?.text !== undefined) element.textContent = options.text;
  if (options?.cls !== undefined) element.className = options.cls;
  for (const [key, value] of Object.entries(options?.attr ?? {})) {
    element.setAttribute(key, value);
  }
  return element;
}

HTMLElement.prototype.createEl = function createEl(
  tag: string,
  options?: CreateElOptions,
): HTMLElement {
  const child = document.createElement(tag);
  this.appendChild(child);
  return apply(child, options);
};

HTMLElement.prototype.createDiv = function createDiv(
  options?: CreateElOptions,
): HTMLElement {
  return this.createEl('div', options);
};

HTMLElement.prototype.onClickEvent = function onClickEvent(
  callback: (event: MouseEvent) => void,
): void {
  this.addEventListener('click', callback);
};

HTMLElement.prototype.addClass = function addClass(name: string): void {
  this.classList.add(name);
};

HTMLElement.prototype.empty = function empty(): void {
  this.replaceChildren();
};

/**
 * Obsidian ships Lucide. Only the glyphs the entry screens ask for are here,
 * drawn at Lucide's own 24x24 viewBox so the stroke weight in `styles.css`
 * lands the same way it does in the app.
 */
const ICONS: Record<string, string> = {
  hexagon:
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
};

export function setIcon(element: HTMLElement, iconId: string): void {
  const path = ICONS[iconId];
  if (path === undefined) return;
  element.innerHTML =
    `<svg class="svg-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round">${path}</svg>`;
}

export {};
