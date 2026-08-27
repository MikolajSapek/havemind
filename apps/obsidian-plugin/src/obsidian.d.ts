declare module 'obsidian' {
  /**
   * What `registerEditorExtension()` accepts. Obsidian passes it straight to
   * CodeMirror, so it is CodeMirror's own `Extension` union (a facet value, a
   * view plugin, or a nested array of either), not just an array, which is what
   * this stub used to say when nothing but an empty placeholder was registered.
   */
  export type EditorExtension = import('@codemirror/state').Extension;

  export interface ObsidianProtocolData {
    action: string;
    [key: string]: string;
  }

  export interface RequestUrlParam {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
  }

  export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    json: unknown;
    text: string;
  }

  export function requestUrl(
    request: RequestUrlParam,
  ): Promise<RequestUrlResponse>;

  export function setIcon(element: HTMLElement, iconId: string): void;

  export abstract class TAbstractFile {
    path: string;
    name: string;
  }

  export class TFile extends TAbstractFile {
    extension: string;
  }

  export class TFolder extends TAbstractFile {
    children: TAbstractFile[];
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }

  export class Modal {
    app: App;
    contentEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }

  export interface ListedFiles {
    files: string[];
    folders: string[];
  }

  export interface FileStats {
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
  }

  /**
   * Low-level filesystem surface for a vault. Unlike the Vault file API, this
   * reaches HIDDEN paths (`.obsidian/`) that `getFiles()` and the `on(...)`
   * events never expose, the only way to enumerate, read and write the config
   * mirror.
   */
  export interface DataAdapter {
    list(normalizedPath: string): Promise<ListedFiles>;
    read(normalizedPath: string): Promise<string>;
    readBinary(normalizedPath: string): Promise<ArrayBuffer>;
    write(normalizedPath: string, data: string): Promise<void>;
    writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
    stat(normalizedPath: string): Promise<FileStats | null>;
    exists(normalizedPath: string): Promise<boolean>;
    mkdir(normalizedPath: string): Promise<void>;
    remove(normalizedPath: string): Promise<void>;
  }

  export interface Vault {
    adapter: DataAdapter;
    configDir: string;
    getAbstractFileByPath(path: string): TAbstractFile | null;
    getMarkdownFiles(): TFile[];
    getFiles(): TFile[];
    read(file: TFile): Promise<string>;
    readBinary(file: TFile): Promise<ArrayBuffer>;
    create(path: string, data: string): Promise<TFile>;
    createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
    modify(file: TFile, data: string): Promise<void>;
    modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
    delete(file: TAbstractFile): Promise<void>;
    createFolder(path: string): Promise<void>;
    on(name: string, callback: (...args: unknown[]) => unknown): EventRef;
    offref(ref: EventRef): void;
  }

  export type EventRef = unknown;

  export interface ViewState {
    active?: boolean;
    type: string;
  }

  export interface WorkspaceLeaf {
    setViewState(state: ViewState): Promise<void>;
  }

  export interface Workspace {
    detachLeavesOfType(type: string): void;
    getLeavesOfType(type: string): WorkspaceLeaf[];
    getRightLeaf(split: boolean): WorkspaceLeaf | null;
    revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
    onLayoutReady(callback: () => void): void;
    on(name: string, callback: (...args: unknown[]) => unknown): unknown;
    /**
     * Fires a workspace event. Used for `css-change`, the signal that makes
     * Obsidian re-read custom CSS (snippets and the active theme), the only way
     * a synced appearance file becomes visible without a restart.
     *
     * The real runtime always provides it; declared OPTIONAL here because this
     * ambient stub is also what the headless test mock is structurally checked
     * against, and a purely cosmetic refresh must not become a hard requirement
     * of every test double. Call sites use `trigger?.(...)` accordingly.
     */
    trigger?(name: string, ...data: unknown[]): void;
    /**
     * Asks Obsidian to re-apply every registered editor extension to all open
     * editors. The author overlay reads its "Show authors" flag live, so this is
     * what makes a toggle visible in Live Preview without an edit or a reload.
     *
     * Declared OPTIONAL for the same reason as `trigger` above: this ambient
     * stub is also the shape the headless test mock is checked against, and a
     * cosmetic refresh must not become a hard requirement of every double.
     * Call sites use `updateOptions?.()`.
     */
    updateOptions?(): void;
  }

  export interface App {
    secretStorage: SecretStorage;
    workspace: Workspace;
  }

  export class SecretStorage {
    getSecret(id: string): string | null;
    listSecrets(): string[];
    setSecret(id: string, secret: string): void;
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
    /**
     * Unconditional action. Optional because a command that guards its own
     * availability supplies `checkCallback` instead, Obsidian accepts either.
     */
    callback?: () => unknown;
    /**
     * Availability-aware action. Obsidian calls it with `true` to ask whether
     * the command applies right now (a `false` answer greys it out in the
     * palette and blocks its hotkey), and with `false` to run it.
     */
    checkCallback?: (checking: boolean) => boolean;
    id: string;
    name: string;
  }

  export abstract class Plugin {
    readonly app: App;
    readonly manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest);

    addCommand(command: Command): void;
    addRibbonIcon(
      icon: string,
      title: string,
      callback: () => unknown,
    ): HTMLElement;
    addSettingTab(settingTab: PluginSettingTab): void;
    addStatusBarItem(): HTMLElement;
    loadData(): Promise<unknown>;
    saveData(data: unknown): Promise<void>;
    registerInterval(id: number): number;
    registerEvent(ref: EventRef): void;
    registerDomEvent(
      target: Window | HTMLElement,
      type: string,
      callback: (event: Event) => unknown,
    ): void;
    onload(): Promise<void> | void;
    onunload(): void;
    registerEditorExtension(extension: EditorExtension): void;
    registerMarkdownPostProcessor(
      processor: (
        element: HTMLElement,
        context: MarkdownPostProcessorContext,
      ) => unknown,
    ): void;
    registerObsidianProtocolHandler(
      action: string,
      handler: (data: ObsidianProtocolData) => unknown,
    ): void;
    registerView(
      type: string,
      creator: (leaf: WorkspaceLeaf) => ItemView,
    ): void;
    unload(): void;
  }

  export abstract class ItemView {
    readonly app: App;
    readonly containerEl: HTMLElement;
    readonly leaf: WorkspaceLeaf;

    constructor(leaf: WorkspaceLeaf);

    abstract getDisplayText(): string;
    getIcon(): string;
    abstract getViewType(): string;
    onClose(): Promise<void> | void;
    onOpen(): Promise<void> | void;
  }

  export abstract class PluginSettingTab {
    readonly app: App;
    readonly containerEl: HTMLElement;
    readonly plugin: Plugin;

    constructor(app: App, plugin: Plugin);

    abstract display(): void;
  }

  export class ButtonComponent {
    setButtonText(text: string): this;
    setCta(): this;
    setDisabled(disabled: boolean): this;
    setTooltip(tooltip: string): this;
    onClick(callback: () => unknown): this;
  }

  export class Setting {
    constructor(containerEl: HTMLElement);

    addButton(callback: (button: ButtonComponent) => unknown): this;
    setDesc(description: string): this;
    setHeading(): this;
    setName(name: string): this;
  }

  /** The section of the source a rendered Reading-view block came from. */
  export interface MarkdownSectionInformation {
    /** The FULL source text of the file being rendered. */
    text: string;
    /** 0-based inclusive first line of this block within `text`. */
    lineStart: number;
    /** 0-based inclusive last line of this block within `text`. */
    lineEnd: number;
  }

  export interface MarkdownPostProcessorContext {
    /** Vault path of the file being rendered. */
    sourcePath: string;
    /**
     * Where this element came from in the source, or `null`. Obsidian documents
     * it as frequently null, which is why the author overlay skips a block
     * outright rather than guessing a range for it.
     */
    getSectionInfo(element: HTMLElement): MarkdownSectionInformation | null;
  }

  /** The file behind a live editor, as carried by `editorInfoField`. */
  export interface MarkdownFileInfo {
    readonly file: TFile | null;
  }

  /**
   * CodeMirror `StateField` holding the {@link MarkdownFileInfo} for an editor.
   * The only supported way for an editor extension to learn WHICH file the view
   * in front of it is showing, which is what keeps per-file attribution
   * correct in split panes instead of following the active file.
   */
  export const editorInfoField: import('@codemirror/state').StateField<MarkdownFileInfo>;
}

interface HTMLElement {
  createDiv(options?: { text?: string }): HTMLDivElement;
  createEl(
    tag: string,
    options?: {
      text?: string;
      value?: string;
      type?: string;
      placeholder?: string;
      cls?: string;
      attr?: Record<string, string>;
    },
  ): HTMLElement;
  empty(): void;
  onClickEvent(callback: () => unknown): void;
  setText(value: string): void;
  value: string;
}
