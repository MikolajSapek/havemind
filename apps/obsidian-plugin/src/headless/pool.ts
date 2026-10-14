/**
 * Agents the background runner keeps open (plan 014). Opening one rebuilds its
 * history from the server, so the runner opens each agent once and holds it,
 * and its lock, for the life of the process; a failed agent is dropped and
 * opened again on a later pass.
 */

export interface Opened<T> {
  readonly agent: T;
  readonly release: () => Promise<void>;
}

export class AgentPool<T> {
  private readonly open = new Map<string, Opened<T>>();

  constructor(private readonly opener: (folder: string) => Promise<Opened<T> | null>) {}

  /** The open agent for `folder`, opening it on first use; null while another process holds it. */
  async get(folder: string): Promise<T | null> {
    const cached = this.open.get(folder);
    if (cached !== undefined) return cached.agent;
    const opened = await this.opener(folder);
    if (opened === null) return null;
    this.open.set(folder, opened);
    return opened.agent;
  }

  async drop(folder: string): Promise<void> {
    const opened = this.open.get(folder);
    this.open.delete(folder);
    await opened?.release();
  }

  async closeAll(): Promise<void> {
    for (const folder of [...this.open.keys()]) await this.drop(folder);
  }
}
