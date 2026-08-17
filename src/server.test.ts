import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { projectId } from './paths.ts';
import { clearServerInfo } from './server-info.ts';
import { startServer } from './server.ts';
import { readIndex, readMode } from './state.ts';

const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SESSION_B = '8ad63f71-e435-4907-844c-6a713219f517';

let stateDir: string;
let prevStateDir: string | undefined;
let projectA: string;
let projectB: string;
let server: Server<never>;
let port: number;
let base: string;

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.claude', 'hview'), { recursive: true });
  return root;
}

/** hook が書くのと同じ場所に HTML を置く。 */
function writeTurnFile(projectRoot: string, sessionId: string, file: string, title: string): void {
  const dir = join(projectRoot, '.claude', 'hview', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `<!DOCTYPE html><title>${title}</title><h1>${title}</h1>`);
}

/** OS に空きポートを 1 つ選ばせて、すぐ返す。 */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const found = portOf(probe);
  probe.stop(true);
  return found;
}

function portOf(s: Server<never>): number {
  if (s.port === undefined) throw new Error('port を取得できませんでした');
  return s.port;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type StateProject = {
  projectId: string;
  projectRoot: string;
  label: string;
  primary: boolean;
  mode: { enabled: boolean; outputMode: string };
  sessions: { sessionId: string; turns: { file: string; title: string }[] }[];
};

async function getState(): Promise<{ projects: StateProject[]; projectRoot: string }> {
  const res = await fetch(`${base}/api/state`);
  return (await res.json()) as { projects: StateProject[]; projectRoot: string };
}

beforeAll(async () => {
  prevStateDir = process.env.HVIEW_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), 'hview-state-'));
  process.env.HVIEW_STATE_DIR = stateDir;

  projectA = makeProject('hview-proj-a-');
  projectB = makeProject('hview-proj-b-');
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = startServer({ projectRoot: projectA, port, quiet: true });
});

afterAll(() => {
  server.stop(true);
  clearServerInfo(projectA);
  if (prevStateDir === undefined) delete process.env.HVIEW_STATE_DIR;
  else process.env.HVIEW_STATE_DIR = prevStateDir;
  for (const d of [stateDir, projectA, projectB]) rmSync(d, { recursive: true, force: true });
});

describe('/api/notify', () => {
  test('起動プロジェクトのターンを取り込む', async () => {
    writeTurnFile(projectA, SESSION_A, 'turn-001.html', 'A の 1 枚目');
    const r = await postJson('/api/notify', {
      projectRoot: projectA,
      sessionId: SESSION_A,
      file: 'turn-001.html',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(readIndex(projectA, SESSION_A).turns.map((t) => t.title)).toEqual(['A の 1 枚目']);
  });

  // チケット #7 の再現そのもの。projectA で serve したまま projectB のターンを通知する
  test('別プロジェクトのターンも取り込む（index.json が作られる）', async () => {
    writeTurnFile(projectB, SESSION_B, 'turn-001.html', 'B の 1 枚目');
    const r = await postJson('/api/notify', {
      projectRoot: projectB,
      sessionId: SESSION_B,
      file: 'turn-001.html',
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.projectId).toBe(projectId(projectB));
    expect(existsSync(join(projectB, '.claude', 'hview', SESSION_B, 'index.json'))).toBe(true);
    expect(readIndex(projectB, SESSION_B).turns.map((t) => t.title)).toEqual(['B の 1 枚目']);
  });

  test('projectRoot を省略したら起動プロジェクト扱い（従来の hook との互換）', async () => {
    writeTurnFile(projectA, SESSION_A, 'turn-002.html', 'A の 2 枚目');
    const r = await postJson('/api/notify', { sessionId: SESSION_A, file: 'turn-002.html' });
    expect(r.status).toBe(200);
    expect(readIndex(projectA, SESSION_A).turns.map((t) => t.file)).toEqual([
      'turn-001.html',
      'turn-002.html',
    ]);
  });

  test('書かれていないファイルは 404', async () => {
    const r = await postJson('/api/notify', {
      projectRoot: projectB,
      sessionId: SESSION_B,
      file: 'turn-999.html',
    });
    expect(r.status).toBe(404);
  });

  test('.claude/hview が無いディレクトリは受け付けない', async () => {
    const r = await postJson('/api/notify', {
      projectRoot: '/etc',
      sessionId: SESSION_B,
      file: 'turn-001.html',
    });
    expect(r.status).toBe(400);
  });

  test('相対パスの projectRoot は受け付けない', async () => {
    const r = await postJson('/api/notify', {
      projectRoot: '../../etc',
      sessionId: SESSION_B,
      file: 'turn-001.html',
    });
    expect(r.status).toBe(400);
  });

  test('セッション ID・ファイル名にパストラバーサルは通さない', async () => {
    for (const bad of [
      { sessionId: '..', file: 'turn-001.html' },
      { sessionId: SESSION_B, file: '../../../etc/passwd' },
    ]) {
      const r = await postJson('/api/notify', { projectRoot: projectB, ...bad });
      expect(r.status).toBe(400);
    }
  });
});

describe('/api/state', () => {
  test('通知を受けた全プロジェクトが並ぶ', async () => {
    const state = await getState();
    const roots = state.projects.map((p) => p.projectRoot);
    expect(roots).toContain(projectA);
    expect(roots).toContain(projectB);
  });

  test('起動プロジェクトが先頭で primary', async () => {
    const state = await getState();
    expect(state.projects[0]?.projectRoot).toBe(projectA);
    expect(state.projects[0]?.primary).toBe(true);
    expect(state.projects.filter((p) => p.primary)).toHaveLength(1);
  });

  test('セッションは projectId 付きで返る（ビューアが別プロジェクトと区別できる）', async () => {
    const state = await getState();
    const b = state.projects.find((p) => p.projectRoot === projectB);
    expect(b?.projectId).toBe(projectId(projectB));
    expect(b?.sessions.map((s) => s.sessionId)).toEqual([SESSION_B]);
    expect(b?.sessions[0]?.turns.map((t) => t.title)).toEqual(['B の 1 枚目']);
  });
});

describe('プレビュー配信', () => {
  test('別プロジェクトの HTML も projectId 付き URL で読める', async () => {
    const res = await fetch(`${base}/f/${projectId(projectB)}/${SESSION_B}/turn-001.html`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('B の 1 枚目');
    // スクロール位置維持のための bridge が注入されている
    expect(body).toContain('__hview');
  });

  test('知らない projectId は 404', async () => {
    const res = await fetch(`${base}/f/${'0'.repeat(12)}/${SESSION_B}/turn-001.html`);
    expect(res.status).toBe(404);
  });

  test('projectId を省いた旧 URL は 404（誤って他プロジェクトを掴まない）', async () => {
    const res = await fetch(`${base}/f/${SESSION_B}/turn-001.html`);
    expect(res.status).toBe(404);
  });

  test('ダウンロードは title からファイル名を作る', async () => {
    const res = await fetch(`${base}/d/${projectId(projectB)}/${SESSION_B}/turn-001.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('B-の-1-枚目.html'));
  });
});

describe('/api/mode', () => {
  test('projectId を指定すると、そのプロジェクトの mode.json だけが変わる', async () => {
    const r = await postJson('/api/mode', { projectId: projectId(projectB), enabled: true });
    expect(r.status).toBe(200);
    expect(readMode(projectB).enabled).toBe(true);
    expect(readMode(projectA).enabled).toBe(false);
  });

  test('projectRoot 指定でも同じ（CLI の hview on / off 経路）', async () => {
    const r = await postJson('/api/mode', { projectRoot: projectB, outputMode: 'single-file' });
    expect(r.status).toBe(200);
    expect(readMode(projectB).outputMode).toBe('single-file');
    expect(readMode(projectA).outputMode).toBe('per-turn');
  });

  test('知らない projectId は 404', async () => {
    const r = await postJson('/api/mode', { projectId: '0'.repeat(12), enabled: true });
    expect(r.status).toBe(404);
  });
});

describe('/api/reindex', () => {
  test('知っているプロジェクトすべてを走査する', async () => {
    // サーバを止めている間に書かれた想定のファイル
    writeTurnFile(projectB, SESSION_B, 'turn-002.html', 'B の 2 枚目');
    const r = await postJson('/api/reindex', {});
    expect(r.status).toBe(200);
    expect(readIndex(projectB, SESSION_B).turns.map((t) => t.file)).toEqual([
      'turn-001.html',
      'turn-002.html',
    ]);
  });
});

describe('WebSocket push', () => {
  test('turn 通知に projectId が載る', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const message = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 4000);
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (msg.type !== 'turn') return; // hello は読み飛ばす
        clearTimeout(timer);
        resolve(msg);
      });
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    writeTurnFile(projectB, SESSION_B, 'turn-003.html', 'B の 3 枚目');
    await postJson('/api/notify', {
      projectRoot: projectB,
      sessionId: SESSION_B,
      file: 'turn-003.html',
    });

    const msg = await message;
    expect(msg.projectId).toBe(projectId(projectB));
    expect(msg.projectRoot).toBe(projectB);
    expect(msg.sessionId).toBe(SESSION_B);
    ws.close();
  });
});
