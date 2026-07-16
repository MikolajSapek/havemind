declare module 'obsidian' {
  export type EditorExtension = readonly unknown[];

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

  export interface Vault {
    getAbstractFileByPath(path: string): TAbstractFile | null;
    getMarkdownFiles(): TFile[];
    read(file: TFile): Promise<string>;
    create(path: string, data: string): Promise<TFile>;
    modify(file: TFile, data: string): Promise<void>;
    delete(file: TAbstractFile): Promise<void>;
    createFolder(path: string): Promise<void>;
  }

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
    callback: () => unknown;
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
    registerDomEvent(
      target: Window,
      type: string,
      callback: () => unknown,
    ): void;
    onload(): Promise<void> | void;
    onunload(): void;
    registerEditorExtension(extension: EditorExtension): void;
    registerMarkdownPostProcessor(
      processor: (element: HTMLElement, context: unknown) => unknown,
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

  export class Setting {
    constructor(containerEl: HTMLElement);

    setDesc(description: string): this;
    setHeading(): this;
    setName(name: string): this;
  }
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
    },
  ): HTMLElement;
  empty(): void;
  onClickEvent(callback: () => unknown): void;
  setText(value: string): void;
  value: string;
}
