import type { Project, SourceMapping } from '../domain/types';

export interface PreviewSession {
  project: Project;
  mode: 'static' | 'proxy';
  /** Served instrumented directory (static mode). */
  siteDir?: string;
  /** Internal loopback URL of a framework dev server (proxy mode). */
  proxyUrl?: string;
  mappings: SourceMapping[];
  mappingById: Map<string, SourceMapping>;
  stop(): Promise<void>;
}

/** In-memory registry of active preview sessions keyed by project id. */
export class PreviewRegistry {
  private sessions = new Map<string, PreviewSession>();

  register(session: PreviewSession): void {
    this.sessions.set(session.project.id, session);
  }

  get(projectId: string): PreviewSession | undefined {
    return this.sessions.get(projectId);
  }

  list(): PreviewSession[] {
    return [...this.sessions.values()];
  }

  async remove(projectId: string): Promise<void> {
    const session = this.sessions.get(projectId);
    if (session) {
      await session.stop();
      this.sessions.delete(projectId);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.stop()));
    this.sessions.clear();
  }
}
