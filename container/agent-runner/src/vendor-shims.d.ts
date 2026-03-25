declare module 'ssh2-sftp-client' {
  export interface FileInfo {
    name: string;
    type: string;
    modifyTime?: number;
  }

  export interface ConnectOptions {
    host: string;
    port?: number;
    username: string;
    privateKey: string;
    readyTimeout?: number;
  }

  export default class SftpClient {
    connect(options: ConnectOptions): Promise<void>;
    end(): Promise<void>;
    exists(remotePath: string): Promise<false | 'd' | '-' | 'l'>;
    list(remotePath: string): Promise<FileInfo[]>;
    delete(remotePath: string): Promise<void>;
    rmdir(remotePath: string, recursive?: boolean): Promise<void>;
  }
}

declare module '@anthropic-ai/claude-agent-sdk' {
  export type HookCallback = (
    input: unknown,
    toolUseId: string | null,
    context: unknown,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;

  export interface PreCompactHookInput {
    transcript_path?: string;
    session_id: string;
  }

  export interface McpServerConfig {
    [key: string]: unknown;
  }

  export function query(...args: unknown[]): AsyncIterable<any>;
}
