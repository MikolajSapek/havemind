type Callback = () => unknown;

type CreateElOptions = {
  text?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  cls?: string;
  attr?: Record<string, string>;
};

export type MockElement = {
  children: MockElement[];
  classes: string[];
  attrs: Record<string, string>;
  placeholder: string;
  addClass: (cls: string) => void;
  /** Records a DOM listener so a test can dispatch it via `triggerEvent`. */
  addEventListener: (
    type: string,
    handler: (event: unknown) => unknown,
  ) => void;
  removeEventListener: (
    type: string,
    handler: (event: unknown) => unknown,
  ) => void;
  createDiv: (options?: { text?: string }) => MockElement;
  createEl: (tag: string, options?: CreateElOptions) => MockElement;
  disabled: boolean;
  empty: () => void;
  iconName: string;
  onClickEvent: (callback: Callback) => void;
  remove: () => void;
  removed: boolean;
  /**
   * Records that focus was moved here. A tablist has to put focus on the tab
   * it just selected — without that, arrow keys announce a new tab while the
   * keyboard is still on the old one — so the tests need to observe it.
   */
  focus: () => void;
  /** True once `focus()` has been called on this element. */
  focused: boolean;
  /** Mirrors `HTMLElement.setAttribute`, writing into `attrs`. */
  setAttribute: (name: string, value: string) => void;
  setText: (value: string) => void;
  style: { setProperty: (name: string, value: string) => void };
  /** Every CSS custom property written through `style.setProperty`. */
  styleProperties: Record<string, string>;
  tag: string;
  text: string;
  value: string;
  triggerClick: () => unknown;
  /** Fires every listener registered for `type` with the supplied event. */
  triggerEvent: (type: string, event?: unknown) => void;
};

type ViewCreator = (leaf: WorkspaceLeaf) => ItemView;

/**
 * The slice of Obsidian's `MarkdownPostProcessorContext` the author overlay
 * uses. Kept structural so a test can hand a plain object to a registered
 * processor without building the whole renderer context.
 */
export interface MarkdownPostProcessorContext {
  sourcePath: string;
  getSectionInfo(
    element: HTMLElement,
  ): { text: string; lineStart: number; lineEnd: number } | null;
}

export type RegistrationState = {
  commands: Command[];
  editorExtensions: EditorExtension[];
  markdownPostProcessors: Array<
    (element: HTMLElement, context: MarkdownPostProcessorContext) => unknown
  >;
  /** Every `Notice` message raised since the last reset, in order. */
  notices: string[];
  protocolHandlers: Map<
    string,
    (data: ObsidianProtocolData) => unknown
  >;
  ribbons: MockElement[];
  settingsTabs: PluginSettingTab[];
  settingsRows: Setting[];
  statusItems: MockElement[];
  views: Map<string, ViewCreator>;
};

export function setIcon(element: unknown, iconId: string): void {
  (element as MockElement).iconName = iconId;
}

/**
 * Minimal stand-in for Obsidian's `Notice` — records the message, no UI. Every
 * message is also appended to `registrationState.notices` so a test can assert
 * what the user was told without holding the instance.
 */
export class Notice {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
    registrationState.notices.push(message);
  }
}

/**
 * Minimal stand-in for Obsidian's `Modal`. `open()` invokes `onOpen()` so a
 * subclass that renders into `contentEl` can be exercised headlessly, and the
 * `opened`/`closed` flags let tests assert the lifecycle.
 */
export class Modal {
  readonly app: App;
  readonly contentEl = createMockElement();
  opened = false;
  closed = false;

  constructor(app: App) {
    this.app = app;
  }

  open(): void {
    this.opened = true;
    this.onOpen();
  }

  close(): void {
    this.closed = true;
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

/** Minimal stand-ins for the vault file classes used in `instanceof` checks. */
export class TAbstractFile {
  path = '';
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

/**
 * `requestUrl` is not exercised by the shared mock; suites that need it mock it
 * explicitly (see `obsidian-adapters.test.ts`). This stub only keeps a bare
 * named export present so modules importing it can load in a headless test.
 */
export function requestUrl(): never {
  throw new Error('requestUrl is not available in the headless obsidian mock');
}

export function createMockElement(): MockElement {
  const children: MockElement[] = [];
  const classes: string[] = [];
  const styleProperties: Record<string, string> = {};
  const listeners = new Map<string, Array<(event: unknown) => unknown>>();
  let clickCallback: Callback = () => undefined;
  const element: MockElement = {
    children,
    classes,
    attrs: {},
    placeholder: '',
    styleProperties,
    addClass(cls: string): void {
      classes.push(cls);
    },
    addEventListener(type: string, handler: (event: unknown) => unknown): void {
      const existing = listeners.get(type) ?? [];
      listeners.set(type, [...existing, handler]);
    },
    disabled: false,
    focused: false,
    focus(): void {
      element.focused = true;
    },
    iconName: '',
    style: {
      setProperty(name: string, value: string): void {
        styleProperties[name] = value;
      },
    },
    createDiv(options?: { text?: string }): MockElement {
      const child = createMockElement();
      child.text = options?.text ?? '';
      children.push(child);
      return child;
    },
    createEl(
      tag: string,
      options?: CreateElOptions,
    ): MockElement {
      const child = createMockElement();
      child.tag = tag;
      child.text = options?.text ?? '';
      child.value = options?.value ?? '';
      child.placeholder = options?.placeholder ?? '';
      if (options?.cls !== undefined) child.classes.push(options.cls);
      if (options?.attr !== undefined) {
        for (const [key, value] of Object.entries(options.attr)) {
          child.attrs[key] = value;
        }
      }
      children.push(child);
      return child;
    },
    empty(): void {
      children.splice(0, children.length);
    },
    removed: false,
    remove(): void {
      element.removed = true;
    },
    removeEventListener(type: string, handler: (event: unknown) => unknown): void {
      const existing = listeners.get(type);
      if (existing === undefined) return;
      const remaining = existing.filter((candidate) => candidate !== handler);
      if (remaining.length === 0) listeners.delete(type);
      else listeners.set(type, remaining);
    },
    setAttribute(name: string, value: string): void {
      element.attrs[name] = value;
    },
    setText(value: string): void {
      element.text = value;
    },
    tag: '',
    text: '',
    value: '',
    triggerClick(): unknown {
      return clickCallback();
    },
    triggerEvent(type: string, event?: unknown): void {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    onClickEvent(callback: Callback): void {
      clickCallback = callback;
    },
  };

  return element;
}

export interface ObsidianProtocolData {
  action: string;
  [key: string]: string;
}

export interface ViewState {
  active?: boolean;
  type: string;
}

export class WorkspaceLeaf {
  readonly states: ViewState[] = [];

  async setViewState(state: ViewState): Promise<void> {
    this.states.push(state);
  }
}

export class Workspace {
  readonly detachedTypes: string[] = [];
  readonly revealedLeaves: WorkspaceLeaf[] = [];
  readonly leaves = new Map<string, WorkspaceLeaf[]>();
  rightLeaf: WorkspaceLeaf | null = new WorkspaceLeaf();

  detachLeavesOfType(type: string): void {
    this.detachedTypes.push(type);
    this.leaves.delete(type);
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.get(type) ?? [];
  }

  getRightLeaf(split: boolean): WorkspaceLeaf | null {
    void split;
    return this.rightLeaf;
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.revealedLeaves.push(leaf);
  }

  /**
   * Counts `updateOptions()` calls — how the plugin asks Obsidian to re-run
   * every registered editor extension after the author overlay is toggled.
   */
  updateOptionsCalls = 0;

  updateOptions(): void {
    this.updateOptionsCalls += 1;
  }

  onLayoutReady(_callback: () => void): void {
    // The layout is never "ready" in the headless mock, so the passive shell
    // never starts the connected sync runtime during lifecycle tests.
    void _callback;
  }

  on(_name: string, _callback: (...args: unknown[]) => unknown): unknown {
    void _callback;
    return undefined;
  }
}

export class App {
  readonly secretStorage = new SecretStorage();
  readonly workspace = new Workspace();
  readonly vault = {
    getMarkdownFilesCalls: 0,
  };
  readonly network = {
    requestCalls: 0,
  };
}

export class SecretStorage {
  private readonly values = new Map<string, string>();

  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }

  listSecrets(): string[] {
    return [...this.values.keys()];
  }

  setSecret(id: string, secret: string): void {
    this.values.set(id, secret);
  }
}

export interface PluginManifest {
  author: string;
  description: string;
  id: string;
  isDesktopOnly: boolean;
  minAppVersion: string;
  name: string;
  version: string;
}

export interface Command {
  /** Unconditional action; absent on a command that guards with checkCallback. */
  callback?: () => unknown;
  /**
   * Availability-aware action, mirroring Obsidian: called with `true` to ask
   * whether the command applies right now (greyed out in the palette when it
   * returns false), and with `false` to actually run it.
   */
  checkCallback?: (checking: boolean) => boolean;
  id: string;
  name: string;
}

/**
 * Whatever `registerEditorExtension()` was handed. Opaque here: the headless
 * suites only count registrations and check teardown, never run CodeMirror.
 */
export type EditorExtension = unknown;

export const registrationState: RegistrationState = {
  commands: [],
  editorExtensions: [],
  markdownPostProcessors: [],
  notices: [],
  protocolHandlers: new Map(),
  ribbons: [],
  settingsTabs: [],
  settingsRows: [],
  statusItems: [],
  views: new Map(),
};

export function resetObsidianMock(): void {
  registrationState.commands.splice(0);
  registrationState.editorExtensions.splice(0);
  registrationState.markdownPostProcessors.splice(0);
  registrationState.notices.splice(0);
  registrationState.protocolHandlers.clear();
  registrationState.ribbons.splice(0);
  registrationState.settingsTabs.splice(0);
  registrationState.settingsRows.splice(0);
  registrationState.statusItems.splice(0);
  registrationState.views.clear();
}

export class Plugin {
  readonly app: App;
  readonly manifest: PluginManifest;
  private readonly cleanup: Callback[] = [];

  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: Command): void {
    registrationState.commands.push(command);
    this.cleanup.push(() => {
      const index = registrationState.commands.indexOf(command);
      if (index >= 0) registrationState.commands.splice(index, 1);
    });
  }

  addRibbonIcon(
    icon: string,
    _title: string,
    callback: Callback,
  ): HTMLElement {
    const element = createMockElement();
    // Records the Lucide icon name so a test can tell two ribbon actions apart.
    element.iconName = icon;
    element.onClickEvent(callback);
    registrationState.ribbons.push(element);
    this.cleanup.push(() => element.remove());
    return element as unknown as HTMLElement;
  }

  addSettingTab(settingTab: PluginSettingTab): void {
    registrationState.settingsTabs.push(settingTab);
    this.cleanup.push(() => {
      const index = registrationState.settingsTabs.indexOf(settingTab);
      if (index >= 0) registrationState.settingsTabs.splice(index, 1);
    });
  }

  addStatusBarItem(): HTMLElement {
    const element = createMockElement();
    registrationState.statusItems.push(element);
    this.cleanup.push(() => element.remove());
    return element as unknown as HTMLElement;
  }

  onload(): Promise<void> | void {}

  onunload(): void {}

  /**
   * Mirrors Obsidian's `registerInterval`: records the timer id so it is cleared
   * when the plugin unloads, and returns it unchanged so callers can clear it
   * early. Lets the invitee rejoin poll be armed and torn down in headless tests.
   */
  registerInterval(id: number): number {
    this.cleanup.push(() => globalThis.clearInterval(id));
    return id;
  }

  /** Mirrors Obsidian's managed DOM listener lifecycle. */
  registerDomEvent(
    target: Pick<MockElement, 'addEventListener' | 'removeEventListener'>,
    type: string,
    callback: (event: unknown) => unknown,
  ): void {
    target.addEventListener(type, callback);
    this.cleanup.push(() => target.removeEventListener(type, callback));
  }

  registerEditorExtension(extension: EditorExtension): void {
    registrationState.editorExtensions.push(extension);
    this.cleanup.push(() => {
      const index = registrationState.editorExtensions.indexOf(extension);
      if (index >= 0) registrationState.editorExtensions.splice(index, 1);
    });
  }

  registerMarkdownPostProcessor(
    processor: (
      element: HTMLElement,
      context: MarkdownPostProcessorContext,
    ) => unknown,
  ): void {
    registrationState.markdownPostProcessors.push(processor);
    this.cleanup.push(() => {
      const index = registrationState.markdownPostProcessors.indexOf(processor);
      if (index >= 0) registrationState.markdownPostProcessors.splice(index, 1);
    });
  }

  registerObsidianProtocolHandler(
    action: string,
    handler: (data: ObsidianProtocolData) => unknown,
  ): void {
    registrationState.protocolHandlers.set(action, handler);
    this.cleanup.push(() => registrationState.protocolHandlers.delete(action));
  }

  registerView(type: string, creator: ViewCreator): void {
    registrationState.views.set(type, creator);
    this.cleanup.push(() => registrationState.views.delete(type));
  }

  unload(): void {
    this.onunload();
    for (const dispose of this.cleanup.reverse()) dispose();
  }
}

export class ItemView {
  readonly app: App;
  readonly containerEl = createMockElement();
  readonly leaf: WorkspaceLeaf;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = new App();
    this.containerEl.createDiv();
    this.containerEl.createDiv();
  }

  getDisplayText(): string {
    return '';
  }

  getIcon(): string {
    return '';
  }

  getViewType(): string {
    return '';
  }

  onClose(): Promise<void> | void {}

  onOpen(): Promise<void> | void {}
}

export class PluginSettingTab {
  readonly app: App;
  readonly containerEl = createMockElement();
  readonly plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}
}

/**
 * Stand-in for Obsidian's `ButtonComponent`. Records the label plus the CTA,
 * tooltip and disabled state a settings row asked for, and exposes `trigger()`
 * so a test can click the button without a DOM.
 */
export class ButtonComponent {
  buttonText = '';
  cta = false;
  disabled = false;
  tooltip = '';
  private click: Callback = () => undefined;

  setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setTooltip(tooltip: string): this {
    this.tooltip = tooltip;
    return this;
  }

  onClick(callback: Callback): this {
    this.click = callback;
    return this;
  }

  trigger(): unknown {
    return this.click();
  }
}

export class Setting {
  readonly descriptions: string[] = [];
  readonly names: string[] = [];
  readonly buttons: ButtonComponent[] = [];
  heading = false;

  constructor(containerEl: unknown) {
    void containerEl;
    registrationState.settingsRows.push(this);
  }

  addButton(callback: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    this.buttons.push(button);
    callback(button);
    return this;
  }

  setDesc(description: string): this {
    this.descriptions.push(description);
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  setName(name: string): this {
    this.names.push(name);
    return this;
  }
}

/**
 * Stand-in for Obsidian's `editorInfoField` — the CodeMirror `StateField` that
 * carries the file behind a live editor. The headless suites never build a real
 * `EditorView`, so nothing ever reads it; the export exists because the Live
 * Preview extension imports it and this module stands in for `obsidian`.
 */
export const editorInfoField = {
  havemindHeadlessStub: true,
};
