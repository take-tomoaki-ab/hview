import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, hviewRoot } from './paths.ts';

export type ServerInfo = { port: number; pid: number; startedAt: string };

function serverFile(projectRoot: string): string {
  return join(hviewRoot(projectRoot), 'server.json');
}

export function writeServerInfo(projectRoot: string, info: ServerInfo): void {
  mkdirSync(hviewRoot(projectRoot), { recursive: true });
  writeFileSync(serverFile(projectRoot), `${JSON.stringify(info, null, 2)}\n`);
}

export function clearServerInfo(projectRoot: string): void {
  try {
    rmSync(serverFile(projectRoot));
  } catch {
    // 既に無いなら何もしない
  }
}

export function readServerInfo(projectRoot: string): ServerInfo | null {
  try {
    const raw = JSON.parse(readFileSync(serverFile(projectRoot), 'utf8')) as Partial<ServerInfo>;
    if (typeof raw.port !== 'number' || typeof raw.pid !== 'number') return null;
    return { port: raw.port, pid: raw.pid, startedAt: String(raw.startedAt ?? '') };
  } catch {
    return null;
  }
}

/** hook 側が使う port。server.json が無ければ既定値にフォールバックする。 */
export function resolvePort(projectRoot: string): number {
  return readServerInfo(projectRoot)?.port ?? DEFAULT_PORT;
}

/** 指定 port で hview サーバが生きているかを確認する。他のプロセスが掴んでいる場合は false。 */
export async function pingServer(port: number, timeoutMs = 700): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: string };
    return body.app === 'hview';
  } catch {
    return false;
  }
}

/** port が誰かに使われているか（hview かどうかは問わない）。 */
export async function isPortTaken(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
    server.stop(true);
    return false;
  } catch {
    return true;
  }
}
