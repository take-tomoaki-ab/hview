import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PORT, hviewRoot, serversFile, userHviewRoot } from './paths.ts';

export type ServerInfo = { port: number; pid: number; startedAt: string };
export type ServerEntry = ServerInfo & { projectRoot: string };

function serverFile(projectRoot: string): string {
  return join(hviewRoot(projectRoot), 'server.json');
}

export function writeServerInfo(projectRoot: string, info: ServerInfo): void {
  mkdirSync(hviewRoot(projectRoot), { recursive: true });
  writeFileSync(serverFile(projectRoot), `${JSON.stringify(info, null, 2)}\n`);
  upsertServerEntry({ ...info, projectRoot });
}

export function clearServerInfo(projectRoot: string): void {
  try {
    rmSync(serverFile(projectRoot));
  } catch {
    // 既に無いなら何もしない
  }
  removeServerEntry(projectRoot);
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

/** プロセスが生きているか。シグナル 0 は送らずに存在確認だけをする。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は「他ユーザーのプロセスとして存在する」なので生存扱いにする
    return (e as { code?: string }).code === 'EPERM';
  }
}

// --- 共通レジストリ（~/.claude/hview/servers.json） ---

export function readServerRegistry(): ServerEntry[] {
  try {
    const raw = JSON.parse(readFileSync(serversFile(), 'utf8')) as { servers?: unknown };
    if (!Array.isArray(raw.servers)) return [];
    return raw.servers.flatMap((e) => {
      const s = e as Partial<ServerEntry>;
      if (typeof s.port !== 'number' || typeof s.pid !== 'number') return [];
      if (typeof s.projectRoot !== 'string' || !s.projectRoot) return [];
      return [{ port: s.port, pid: s.pid, projectRoot: s.projectRoot, startedAt: String(s.startedAt ?? '') }];
    });
  } catch {
    return [];
  }
}

/** 死んだプロセスの分を落としたレジストリ。 */
export function liveServers(): ServerEntry[] {
  return readServerRegistry().filter((e) => isPidAlive(e.pid));
}

function writeServerRegistry(entries: ServerEntry[]): void {
  mkdirSync(userHviewRoot(), { recursive: true });
  const dest = serversFile();
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ servers: entries }, null, 2)}\n`);
  renameSync(tmp, dest);
}

/** ポート単位で 1 件。同じポートの古い記録は上書きし、死んだプロセスの記録はこの機に捨てる。 */
export function upsertServerEntry(entry: ServerEntry): void {
  const kept = readServerRegistry().filter(
    (e) => e.port !== entry.port && e.projectRoot !== entry.projectRoot && isPidAlive(e.pid),
  );
  writeServerRegistry([...kept, entry]);
}

export function removeServerEntry(projectRoot: string): void {
  const before = readServerRegistry();
  const kept = before.filter((e) => e.projectRoot !== projectRoot && isPidAlive(e.pid));
  if (kept.length !== before.length) writeServerRegistry(kept);
}

/**
 * hook 側が使うポート。
 * 1. そのプロジェクトで serve していれば、その `server.json`
 * 2. なければ共通レジストリの生きているサーバ（同じ projectRoot 優先、次に起動が新しいもの）
 * 3. どれも無ければ既定値
 *
 * 2 がこの関数の要点。`hview serve` を別プロジェクトで動かしている場合、
 * 通知先のプロジェクトには `server.json` が無い。既定値へのフォールバックだけだと
 * ポートを変えて起動していたときに通知がどこにも届かず、完全に無音で落ちる。
 */
export function resolvePort(projectRoot: string): number {
  const own = readServerInfo(projectRoot);
  if (own && isPidAlive(own.pid)) return own.port;

  const live = liveServers();
  const mine = live.find((e) => e.projectRoot === projectRoot);
  if (mine) return mine.port;
  const latest = live.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (latest) return latest.port;

  return own?.port ?? DEFAULT_PORT;
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
