import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { injectBridge, PREVIEW_CSP } from './bridge.ts';
import {
  DEFAULT_EXPORT_DIR,
  hviewRoot,
  isSafeSegment,
  sessionDir,
} from './paths.ts';
import { clearServerInfo, writeServerInfo } from './server-info.ts';
import {
  listSessions,
  readIndex,
  readMode,
  recordTurn,
  writeMode,
  type OutputMode,
} from './state.ts';
import { VIEWER_CSS, VIEWER_HTML, VIEWER_JS } from './viewer.ts';

type WsData = { id: number };
type Client = ServerWebSocket<WsData>;

export type ServeOptions = { projectRoot: string; port: number; quiet?: boolean };

export function startServer(options: ServeOptions) {
  const { projectRoot, port } = options;
  const clients = new Set<Client>();
  let nextId = 1;

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of clients) {
      try {
        c.send(text);
      } catch {
        // 切断済みのクライアントは次の close で片付く
      }
    }
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

  const snapshot = () => ({
    projectRoot,
    port,
    mode: readMode(projectRoot),
    sessions: listSessions(projectRoot).map((s) => ({
      ...s,
      turns: readIndex(projectRoot, s.sessionId).turns,
    })),
    exportDir: DEFAULT_EXPORT_DIR,
  });

  const server = Bun.serve<WsData, never>({
    port,
    hostname: '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/ws') {
        if (srv.upgrade(req, { data: { id: nextId++ } })) return undefined as unknown as Response;
        return new Response('websocket upgrade failed', { status: 400 });
      }

      if (path === '/api/ping') return json({ app: 'hview', port, projectRoot });
      if (path === '/') return html(VIEWER_HTML);
      if (path === '/viewer.css') return asset(VIEWER_CSS, 'text/css; charset=utf-8');
      if (path === '/viewer.js') return asset(VIEWER_JS, 'text/javascript; charset=utf-8');
      if (path === '/api/state') return json(snapshot());

      // プレビュー本体。sandbox iframe から読まれる
      const preview = matchFile('/f/', path);
      if (preview) {
        const file = resolveTurnFile(projectRoot, preview.sessionId, preview.file);
        if (!file) return new Response('not found', { status: 404 });
        return new Response(injectBridge(readFileSync(file, 'utf8')), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': PREVIEW_CSP,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      // ダウンロード。こちらは手を加えていない元の HTML を返す
      const download = matchFile('/d/', path);
      if (download) {
        const file = resolveTurnFile(projectRoot, download.sessionId, download.file);
        if (!file) return new Response('not found', { status: 404 });
        const name = downloadName(readFileSync(file, 'utf8'), download.file);
        return new Response(Bun.file(file), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'no-store',
          },
        });
      }

      if (req.method === 'POST' && path === '/api/notify') {
        const body = (await req.json().catch(() => ({}))) as {
          sessionId?: string;
          file?: string;
        };
        if (!body.sessionId || !body.file || !isSafeSegment(body.sessionId) || !isSafeSegment(body.file)) {
          return json({ ok: false, error: 'bad request' }, 400);
        }
        if (!existsSync(join(sessionDir(projectRoot, body.sessionId), body.file))) {
          return json({ ok: false, error: 'file not found' }, 404);
        }
        const turn = recordTurn(projectRoot, body.sessionId, body.file);
        if (!options.quiet) {
          console.log(`[hview] turn ${turn.n} — ${turn.title} (${body.sessionId.slice(0, 8)})`);
        }
        broadcast({ type: 'turn', sessionId: body.sessionId, turn, state: snapshot() });
        return json({ ok: true, turn });
      }

      if (req.method === 'POST' && path === '/api/mode') {
        const body = (await req.json().catch(() => ({}))) as {
          enabled?: boolean;
          outputMode?: OutputMode;
        };
        const patch: { enabled?: boolean; outputMode?: OutputMode } = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (body.outputMode === 'per-turn' || body.outputMode === 'single-file') {
          patch.outputMode = body.outputMode;
        }
        const mode = writeMode(projectRoot, patch);
        broadcast({ type: 'mode', mode, state: snapshot() });
        return json({ ok: true, mode });
      }

      if (req.method === 'POST' && path === '/api/export') {
        const body = (await req.json().catch(() => ({}))) as {
          sessionId?: string;
          file?: string;
        };
        if (!body.sessionId || !body.file) return json({ ok: false, error: 'bad request' }, 400);
        const src = resolveTurnFile(projectRoot, body.sessionId, body.file);
        if (!src) return json({ ok: false, error: 'file not found' }, 404);
        const content = readFileSync(src, 'utf8');
        mkdirSync(DEFAULT_EXPORT_DIR, { recursive: true });
        const dest = uniquePath(join(DEFAULT_EXPORT_DIR, exportName(content, body.file)));
        writeFileSync(dest, content);
        if (!options.quiet) console.log(`[hview] exported → ${dest}`);
        return json({ ok: true, path: dest });
      }

      if (req.method === 'POST' && path === '/api/reindex') {
        const found = reindexAll(projectRoot);
        broadcast({ type: 'mode', mode: readMode(projectRoot), state: snapshot() });
        return json({ ok: true, found });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws: Client) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'hello', state: snapshot() }));
      },
      close(ws: Client) {
        clients.delete(ws);
      },
      message() {
        // ビューアからの指示は HTTP 側で受ける。WS は push 専用
      },
    },
  });

  writeServerInfo(projectRoot, { port, pid: process.pid, startedAt: new Date().toISOString() });

  const shutdown = () => {
    clearServerInfo(projectRoot);
    server.stop(true);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

function html(body: string) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function asset(body: string, type: string) {
  return new Response(body, {
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  });
}

function matchFile(prefix: string, path: string): { sessionId: string; file: string } | null {
  if (!path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('/').map(decodeURIComponent);
  if (parts.length !== 2) return null;
  const [sessionId, file] = parts;
  if (!sessionId || !file) return null;
  if (!isSafeSegment(sessionId) || !isSafeSegment(file) || !file.endsWith('.html')) return null;
  return { sessionId, file };
}

function resolveTurnFile(projectRoot: string, sessionId: string, file: string): string | null {
  const p = join(sessionDir(projectRoot, sessionId), file);
  return existsSync(p) ? p : null;
}

/** `<title>` からファイル名を作る。取れなければ元のファイル名のまま。 */
function downloadName(content: string, fallback: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content.slice(0, 8192));
  const title = m?.[1]?.trim();
  if (!title) return fallback;
  const safe = title
    .replace(/[\\/:*?"<>|\n\r\t]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe ? `${safe}.html` : fallback;
}

/**
 * `~/Desktop/codes/html-output` は既存の `/html` スキルの出力先で、
 * `YYYYMMDD-HHMM-<slug>.html` という命名で時系列に並んでいる。揃えておく。
 */
function exportName(content: string, fallback: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${stamp}-${downloadName(content, fallback)}`;
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dir = path.slice(0, path.length - basename(path).length);
  const name = basename(path).replace(/\.html$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = join(dir, `${name}-${i}.html`);
    if (!existsSync(candidate)) return candidate;
  }
  return path;
}

/** サーバを止めている間に書かれた HTML を index.json に取り込む。 */
export function reindexAll(projectRoot: string): number {
  const root = hviewRoot(projectRoot);
  if (!existsSync(root)) return 0;
  let count = 0;
  const glob = new Bun.Glob('*/*.html');
  for (const rel of glob.scanSync({ cwd: root })) {
    const [sessionId, file] = rel.split('/');
    if (!sessionId || !file) continue;
    recordTurn(projectRoot, sessionId, file);
    count++;
  }
  return count;
}
