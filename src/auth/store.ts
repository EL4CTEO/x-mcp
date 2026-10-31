import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.ts';

export interface StoredOAuth2 {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  tokenType?: string;
  redirectUri?: string;
}

export interface StoredCredentials {
  version: 1;
  oauth2?: StoredOAuth2;
  updatedAt?: string;
}

const EMPTY: StoredCredentials = { version: 1 };

/**
 * Tokens live outside the repository in a 0600 file. Environment variables
 * always take precedence; this file only exists so `x-mcp auth` can hand a
 * refreshed, long-lived session to the server.
 */
export class CredentialStore {
  readonly file: string;
  private readonly logger: Logger;
  private cached?: StoredCredentials;

  constructor(file: string, logger: Logger) {
    this.file = file;
    this.logger = logger;
  }

  load(): StoredCredentials {
    if (this.cached) return this.cached;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn({ file: this.file, err: String(error) }, 'could not read credential file');
      }
      this.cached = EMPTY;
      return EMPTY;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredCredentials(parsed)) throw new Error('unexpected shape');
      this.cached = parsed;
      return parsed;
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
        this.logger.warn({ file: this.file, backup, err: String(error) }, 'corrupt credential file moved aside');
      } catch {
        this.logger.warn({ file: this.file, err: String(error) }, 'corrupt credential file ignored');
      }
      this.cached = EMPTY;
      return EMPTY;
    }
  }

  get oauth2(): StoredOAuth2 | undefined {
    return this.load().oauth2;
  }

  saveOAuth2(value: StoredOAuth2): void {
    const next: StoredCredentials = {
      version: 1,
      oauth2: value,
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    this.cached = next;
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (error) {
      this.logger.warn({ file: this.file, err: String(error) }, 'could not remove credential file');
    }
    this.cached = EMPTY;
  }

  private write(value: StoredCredentials): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {
        // Best effort: some filesystems (e.g. WSL mounts) reject chmod.
      }
    }
  }
}

function isStoredCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return false;
  if (candidate.oauth2 === undefined) return true;
  if (typeof candidate.oauth2 !== 'object' || candidate.oauth2 === null) return false;
  const oauth2 = candidate.oauth2 as Record<string, unknown>;
  return typeof oauth2.clientId === 'string' && typeof oauth2.accessToken === 'string';
}
