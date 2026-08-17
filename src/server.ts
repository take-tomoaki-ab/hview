import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { injectBridge, PREVIEW_CSP } from './bridge.ts';
import {
  DEFAULT_EXPORT_DIR,
  hviewRoot,
  isHviewProjectRoot,
  isSafeSegment,
  normalizeProjectRoot,
  projectId,
  projectLabel,
  sessionDir,
} from './paths.ts';
import { readKnownProjects, rememberProject } from './projects.ts';
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
  const { projectRoot: primaryRoot, port } = options;
  const clients = new Set<Client>();
  let nextId = 1;

  /**
   * このサーバが面倒を見ているプロジェクト。projectId → projectRoot。
   * 起動プロジェクトに加えて、`/api/notify` が運んできた projectRoot と、
   * 過去に見たプロジェクト（`~/.claude/hview/projects.json`）を持つ。
   * hook は `install-hooks --user` で全プロジェクトに入るので、サーバ側も 1 プロジェクト専用にはできない。
   */
  const projects = new Map<string, string>();

  const register = (root: string) => {
    const id = projectId(root);
    if (!projects.has(id)) projects.set(id, root);
    rememberProject(root);
    return id;
  };

  register(primaryRoot);
  for (const root of readKnownProjects()) projects.set(projectId(root), root);

  const rootOf = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const root = projects.get(id);
    return root && isHviewProjectRoot(root) ? root : null;
  };

  /** ビューア／CLI から来た projectId・projectRoot を projectRoot に解決する。既定は起動プロジェクト。 */
  const targetRoot = (body: { projectId?: string; projectRoot?: string }): string | null => {
    if (body.projectId !== undefined) return rootOf(body.projectId);
    if (body.projectRoot !== undefined) {
      const root = normalizeProjectRoot(body.projectRoot);
      return root && isHviewProjectRoot(root) ? root : null;
    }
    return primaryRoot;
  };

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

  const projectState = (id: string, root: string) => ({
    projectId: id,
    projectRoot: root,
    label: projectLabel(root),
    primary: root === primaryRoot,
    mode: readMode(root),
    sessions: listSessions(root).map((s) => ({
      ...s,
      projectId: id,
      turns: readIndex(root, s.sessionId).turns,
    })),
  });

  const snapshot = () => {
    const all = [...projects.entries()]
      .filter(([, root]) => isHviewProjectRoot(root))
      .map(([id, root]) => projectState(id, root))
      // ターンが 1 つも無い他プロジェクトは出さない。起動プロジェクトは空でも残す（トグルの置き場所）
      .filter((p) => p.primary || p.sessions.length > 0)
      // 起動プロジェクトを先頭に固定し、残りは名前順。ターンが届くたびに並びが動くと選びにくい
      .sort((a, b) =>
        a.primary !== b.primary ? (a.primary ? -1 : 1) : a.label.localeCompare(b.label),
      );

    return {
      port,
      projectRoot: primaryRoot,
      projectId: projectId(primaryRoot),
      mode: readMode(primaryRoot),
      exportDir: DEFAULT_EXPORT_DIR,
      projects: all,
    };
  };

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

      if (path === '/api/ping') {
        return json({ app: 'hview', port, projectRoot: primaryRoot, projects: [...projects.values()] });
      }
      if (path === '/') return html(VIEWER_HTML);
      if (path === '/viewer.css') return asset(VIEWER_CSS, 'text/css; charset=utf-8');
      if (path === '/viewer.js') return asset(VIEWER_JS, 'text/javascript; charset=utf-8');
      if (path === '/api/state') return json(snapshot());

      // プレビュー本体。sandbox iframe から読まれる
      const preview = matchFile('/f/', path);
      if (preview) {
        const file = resolveTurnFile(rootOf(preview.projectId), preview.sessionId, preview.file);
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
        const file = resolveTurnFile(rootOf(download.projectId), download.sessionId, download.file);
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
          projectRoot?: string;
          sessionId?: string;
          file?: string;
        };
        if (!body.sessionId || !body.file || !isSafeSegment(body.sessionId) || !isSafeSegment(body.file)) {
          return json({ ok: false, error: 'bad request' }, 400);
        }
        // hook は自分のプロジェクトの projectRoot を送ってくる。サーバの起動プロジェクトとは限らない
        const root = body.projectRoot === undefined ? primaryRoot : normalizeProjectRoot(body.projectRoot);
        if (!root) return json({ ok: false, error: 'bad projectRoot' }, 400);
        if (!isHviewProjectRoot(root)) {
          return json({ ok: false, error: 'not an hview project (.claude/hview がありません)' }, 400);
        }
        if (!existsSync(join(sessionDir(root, body.sessionId), body.file))) {
          return json({ ok: false, error: 'file not found' }, 404);
        }

        const id = register(root);
        const turn = recordTurn(root, body.sessionId, body.file);
        if (!options.quiet) {
          const where = root === primaryRoot ? '' : ` [${projectLabel(root)}]`;
          console.log(
            `[hview] turn ${turn.n} — ${turn.title} (${body.sessionId.slice(0, 8)})${where}`,
          );
        }
        broadcast({
          type: 'turn',
          projectId: id,
          projectRoot: root,
          sessionId: body.sessionId,
          turn,
          state: snapshot(),
        });
        return json({ ok: true, projectId: id, turn });
      }

      if (req.method === 'POST' && path === '/api/mode') {
        const body = (await req.json().catch(() => ({}))) as {
          projectId?: string;
          projectRoot?: string;
          enabled?: boolean;
          outputMode?: OutputMode;
        };
        const root = targetRoot(body);
        if (!root) return json({ ok: false, error: 'unknown project' }, 404);
        register(root); // 別プロジェクトの `hview on` でも、以後そのプロジェクトを見るようにする
        const patch: { enabled?: boolean; outputMode?: OutputMode } = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (body.outputMode === 'per-turn' || body.outputMode === 'single-file') {
          patch.outputMode = body.outputMode;
        }
        const mode = writeMode(root, patch);
        broadcast({ type: 'mode', projectId: projectId(root), mode, state: snapshot() });
        return json({ ok: true, projectId: projectId(root), projectRoot: root, mode });
      }

      if (req.method === 'POST' && path === '/api/export') {
        const body = (await req.json().catch(() => ({}))) as {
          projectId?: string;
          projectRoot?: string;
          sessionId?: string;
          file?: string;
        };
        if (!body.sessionId || !body.file) return json({ ok: false, error: 'bad request' }, 400);
        const src = resolveTurnFile(targetRoot(body), body.sessionId, body.file);
        if (!src) return json({ ok: false, error: 'file not found' }, 404);
        const content = readFileSync(src, 'utf8');
        mkdirSync(DEFAULT_EXPORT_DIR, { recursive: true });
        const dest = uniquePath(join(DEFAULT_EXPORT_DIR, exportName(content, body.file)));
        writeFileSync(dest, content);
        if (!options.quiet) console.log(`[hview] exported → ${dest}`);
        return json({ ok: true, path: dest });
      }

      if (req.method === 'POST' && path === '/api/reindex') {
        // 知っているプロジェクトすべてを走査する。他プロジェクトの取りこぼしもここで拾える
        let found = 0;
        for (const root of projects.values()) found += reindexAll(root);
        broadcast({ type: 'mode', mode: readMode(primaryRoot), state: snapshot() });
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

  writeServerInfo(primaryRoot, { port, pid: process.pid, startedAt: new Date().toISOString() });

  const shutdown = () => {
    clearServerInfo(primaryRoot);
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

/** `/f/<projectId>/<sessionId>/<file>` を分解する。3 要素すべてが安全な文字列でなければ弾く。 */
function matchFile(
  prefix: string,
  path: string,
): { projectId: string; sessionId: string; file: string } | null {
  if (!path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('/').map(decodeURIComponent);
  if (parts.length !== 3) return null;
  const [id, sessionId, file] = parts;
  if (!id || !sessionId || !file) return null;
  if (!isSafeSegment(id) || !isSafeSegment(sessionId) || !isSafeSegment(file)) return null;
  if (!file.endsWith('.html')) return null;
  return { projectId: id, sessionId, file };
}

function resolveTurnFile(projectRoot: string | null, sessionId: string, file: string): string | null {
  if (!projectRoot) return null;
  if (!isSafeSegment(sessionId) || !isSafeSegment(file)) return null;
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
