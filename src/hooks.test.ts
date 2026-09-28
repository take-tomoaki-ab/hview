import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { addComment, normalizeTurnArg, readComments, readPendingEdit } from './comments.ts';
import { isHviewControlPrompt, parseHviewEditPrompt } from './instructions.ts';
import { readIndex } from './state.ts';

const CLI = join(import.meta.dir, 'cli.ts');
let projectRoot: string;
let stateDir: string;

/**
 * hook は別プロセスとして走るので、実際に起こして stdin に JSON を流す。
 * `HVIEW_STATE_DIR` を渡すのは、共通レジストリ経由で**本物の**起動中サーバに
 * 通知を飛ばしてしまわないようにするため。
 */
function spawnHook(event: string, payload: unknown) {
  return Bun.spawn(['bun', 'run', CLI, 'hook', event], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HVIEW_STATE_DIR: stateDir },
  });
}

async function runHook(prompt: string): Promise<string> {
  const proc = spawnHook('user-prompt-submit', {
    session_id: 'test-session',
    cwd: projectRoot,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** セッションとイベントを選んで hook を走らせ、stdout を返す。`/hview edit` のテスト用。 */
async function runHookAs(
  sessionId: string,
  event: 'user-prompt-submit' | 'post-tool-use',
  extra: Record<string, unknown>,
): Promise<string> {
  const proc = spawnHook(event, {
    session_id: sessionId,
    cwd: projectRoot,
    hook_event_name: event === 'user-prompt-submit' ? 'UserPromptSubmit' : 'PostToolUse',
    ...extra,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

function portOf(s: Server<never>): number {
  if (s.port === undefined) throw new Error('port を取得できませんでした');
  return s.port;
}

/** PostToolUse hook を走らせて、stderr と終了コードを見る。 */
async function runPostToolUse(filePath: string): Promise<{ code: number; stderr: string }> {
  const proc = spawnHook('post-tool-use', {
    session_id: 'test-session',
    cwd: projectRoot,
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath },
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

function setMode(enabled: boolean): void {
  writeFileSync(
    join(projectRoot, '.claude', 'hview', 'mode.json'),
    `${JSON.stringify({ enabled, outputMode: 'per-turn', updatedAt: new Date(0).toISOString() })}\n`,
  );
}

/** 注入されたか（= additionalContext を吐いたか）。 */
function injected(out: string): boolean {
  return out.includes('hview-instructions');
}

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'hview-hook-'));
  mkdirSync(join(projectRoot, '.claude', 'hview'), { recursive: true });
  stateDir = mkdtempSync(join(tmpdir(), 'hview-hook-state-'));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('isHviewControlPrompt', () => {
  const control = [
    '/hview off',
    'hview off',
    '/hview on',
    '/hview',
    'hview',
    'hview status',
    'hview mode single-file',
    '  /hview off  ',
    '/HVIEW OFF',
    'hview を切って',
    'hview、切って',
  ];
  for (const prompt of control) {
    test(`操作コマンドとして拾う: ${JSON.stringify(prompt)}`, () => {
      expect(isHviewControlPrompt(prompt)).toBe(true);
    });
  }

  const notControl = [
    'ふつうの質問です',
    'hviewer の話をして',
    'hview.ts を読んで',
    'この設計を hview で見せて',
    '',
  ];
  for (const prompt of notControl) {
    test(`操作コマンドとして拾わない: ${JSON.stringify(prompt)}`, () => {
      expect(isHviewControlPrompt(prompt)).toBe(false);
    });
  }
});

describe('UserPromptSubmit hook（モード ON）', () => {
  beforeAll(() => setMode(true));

  test('/hview off は注入しない', async () => {
    expect(injected(await runHook('/hview off'))).toBe(false);
  });

  test('hview off は注入しない', async () => {
    expect(injected(await runHook('hview off'))).toBe(false);
  });

  test('hview status は注入しない', async () => {
    expect(injected(await runHook('hview status'))).toBe(false);
  });

  test('hview mode single-file は注入しない', async () => {
    expect(injected(await runHook('hview mode single-file'))).toBe(false);
  });

  test('ふつうの質問は注入する', async () => {
    expect(injected(await runHook('ふつうの質問です'))).toBe(true);
  });
});

describe('UserPromptSubmit hook（モード OFF）', () => {
  beforeAll(() => setMode(false));

  test('/hview on は注入しない（従来どおり）', async () => {
    expect(injected(await runHook('/hview on'))).toBe(false);
  });

  test('ふつうの質問は注入しない', async () => {
    expect(injected(await runHook('ふつうの質問です'))).toBe(false);
  });

  test('#html を書いたターンは注入する', async () => {
    expect(injected(await runHook('この設計を整理して #html'))).toBe(true);
  });

  test('#html があっても hview の操作コマンドなら注入しない', async () => {
    expect(injected(await runHook('/hview off #html'))).toBe(false);
  });
});

/**
 * PostToolUse hook。HTML は書けているのに通知が通らないケースを黙って落とさないこと。
 * サーバが応答したうえで断った場合だけ知らせる（未起動は従来どおり無音）。
 */
describe('PostToolUse hook', () => {
  let fake: Server<never>;
  let status = 200;
  let requests: { projectRoot?: string; sessionId?: string; file?: string }[] = [];
  /** projectRoot は上位の beforeAll で決まるので、パスの組み立てもそこまで待つ。 */
  let target: string;

  function pointServerJsonAt(port: number): void {
    writeFileSync(
      join(projectRoot, '.claude', 'hview', 'server.json'),
      `${JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
  }

  beforeAll(() => {
    target = join(projectRoot, '.claude', 'hview', 'test-session', 'turn-001.html');
    mkdirSync(join(projectRoot, '.claude', 'hview', 'test-session'), { recursive: true });
    writeFileSync(target, '<!DOCTYPE html><title>テスト</title>');
    fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        requests.push((await req.json()) as { projectRoot?: string });
        return new Response(JSON.stringify({ ok: status === 200 }), { status });
      },
    });
    pointServerJsonAt(portOf(fake));
  });

  afterAll(() => {
    fake.stop(true);
    rmSync(join(projectRoot, '.claude', 'hview', 'server.json'), { force: true });
  });

  beforeEach(() => {
    requests = [];
    status = 200;
  });

  test('通知が通れば無言で終わる', async () => {
    const r = await runPostToolUse(target);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.projectRoot).toBe(projectRoot);
    expect(requests[0]?.sessionId).toBe('test-session');
    expect(requests[0]?.file).toBe('turn-001.html');
  });

  test('サーバが受け取りを断ったら stderr に出して非 0 で終わる', async () => {
    status = 404;
    const r = await runPostToolUse(target);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('[hview]');
    expect(r.stderr).toContain(target);
    expect(r.stderr).toContain('hview serve');
  });

  test('サーバが起きていなければ無音（作業を止めない）', async () => {
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const deadPort = portOf(dead);
    dead.stop(true);
    pointServerJsonAt(deadPort);
    try {
      const r = await runPostToolUse(target);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      pointServerJsonAt(portOf(fake));
    }
  });

  test('hview 配下でない書き込みは通知しない', async () => {
    const r = await runPostToolUse(join(projectRoot, 'src', 'index.ts'));
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(0);
  });
});

describe('parseHviewEditPrompt', () => {
  const cases: [string, string | null][] = [
    ['/hview edit', null],
    ['hview edit', null],
    ['/hview edit turn-003', 'turn-003'],
    ['/hview edit 3', '3'],
    ['  /HVIEW EDIT turn-003.html  ', 'turn-003.html'],
  ];
  for (const [prompt, arg] of cases) {
    test(`edit として拾う: ${JSON.stringify(prompt)}`, () => {
      expect(parseHviewEditPrompt(prompt)).toEqual({ arg });
    });
  }

  for (const prompt of ['/hview off', '/hview editor', 'edit して', 'この hview edit の設計']) {
    test(`edit として拾わない: ${JSON.stringify(prompt)}`, () => {
      expect(parseHviewEditPrompt(prompt)).toBeNull();
    });
  }
});

describe('normalizeTurnArg', () => {
  test('数字は turn-NNN.html にする', () => expect(normalizeTurnArg('3')).toBe('turn-003.html'));
  test('拡張子を補う', () => expect(normalizeTurnArg('turn-012')).toBe('turn-012.html'));
  test('英単語は版とみなさない', () => expect(normalizeTurnArg('please')).toBeNull());
  test('そのまま通す', () => expect(normalizeTurnArg('current.html')).toBe('current.html'));
  test('パスは拒否する', () => expect(normalizeTurnArg('../x.html')).toBeNull());
});

describe('/hview edit', () => {
  const sid = 'edit-session';
  const dir = () => join(projectRoot, '.claude', 'hview', sid);

  async function run(prompt: string, sessionId = sid): Promise<string> {
    return runHookAs(sessionId, 'user-prompt-submit', { prompt });
  }

  beforeAll(() => {
    setMode(false);
    // PostToolUse の通知先を閉じたポートに向ける。既定の 5757 だと手元で動いている本物のサーバに届く
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const deadPort = portOf(dead);
    dead.stop(true);
    writeFileSync(
      join(projectRoot, '.claude', 'hview', 'server.json'),
      `${JSON.stringify({ port: deadPort, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'turn-001.html'), '<title>一</title><body><h2>見出し</h2></body>');
    writeFileSync(join(dir(), 'turn-002.html'), '<title>二</title><body></body>');
    writeFileSync(
      join(dir(), 'index.json'),
      JSON.stringify({
        sessionId: sid,
        turns: [1, 2].map((n) => ({
          n,
          file: `turn-00${n}.html`,
          title: String(n),
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })),
      }),
    );
  });

  afterAll(() => {
    rmSync(join(projectRoot, '.claude', 'hview', 'server.json'), { force: true });
  });

  test('コメントが無ければ HTML を書かせない案内だけを注入する', async () => {
    const out = await run('/hview edit');
    expect(out).toContain('未反映のコメントはありません');
    expect(out).not.toContain('Write ツールで');
  });

  test('一番新しい版の未反映コメントを注入し、新しい turn に書かせる', async () => {
    addComment(projectRoot, sid, {
      file: 'turn-001.html',
      target: { selector: 'body > h2', tag: 'h2', text: '見出し', html: '<h2>見出し</h2>', heading: '' },
      body: '見出しを短く',
    });
    addComment(projectRoot, sid, { file: 'turn-002.html', target: null, body: '全体をもっと簡潔に' });

    const out = await run('/hview edit');
    expect(out).toContain('turn-002.html');
    expect(out).toContain('全体をもっと簡潔に');
    expect(out).toContain('ページ全体');
    expect(out).not.toContain('見出しを短く');
    expect(out).toContain(`.claude/hview/${sid}/turn-003.html`);
    // 操作ターン向けの「HTML を書くな」の但し書きは入れない
    expect(out).not.toContain('HTML は書かずに実行結果だけ');
  });

  test('版を指定すればその版のコメントを使う', async () => {
    const out = await run('/hview edit 1');
    expect(out).toContain('見出しを短く');
    expect(out).toContain('body > h2');
    expect(out).not.toContain('全体をもっと簡潔に');
  });

  test('出力が書かれたらコメントを反映済みにし、元の版を記録する', async () => {
    await run('/hview edit 1');
    writeFileSync(join(dir(), 'turn-003.html'), '<title>一の修正版</title>');
    await runHookAs(sid, 'post-tool-use', {
      tool_name: 'Write',
      tool_input: { file_path: join(dir(), 'turn-003.html') },
    });

    const comments = readComments(projectRoot, sid);
    const applied = comments.find((c) => c.body === '見出しを短く');
    expect(applied?.status).toBe('applied');
    expect(applied?.appliedIn).toBe('turn-003.html');
    expect(comments.find((c) => c.body === '全体をもっと簡潔に')?.status).toBe('open');

    const turn = readIndex(projectRoot, sid).turns.find((t) => t.file === 'turn-003.html');
    expect(turn?.revisionOf).toBe('turn-001.html');
  });

  test('edit 以外のターンに入ると、書かれなかった edit の予約は捨てる', async () => {
    await run('/hview edit');
    expect(readPendingEdit(projectRoot, sid)).not.toBeNull();
    await run('ふつうの質問です');
    expect(readPendingEdit(projectRoot, sid)).toBeNull();
  });

  test('別セッションのコメントは拾わず、あることだけを案内する', async () => {
    const out = await run('/hview edit', 'other-session');
    expect(out).toContain('このセッションに未反映のコメントはありません');
    expect(out).toContain('/hview edit edit-ses/2');
    expect(out).not.toContain('Write ツールで');
  });

  test('自由文が続いても指定なしとして扱う', async () => {
    const out = await run('/hview edit\n\n試しにコメント書いてみた');
    expect(out).toContain('全体をもっと簡潔に');
  });

  test('セッションを明示すれば別セッションの版を作り直し、そのセッションに書かせる', async () => {
    const out = await run('/hview edit edit-ses/2', 'other-session');
    expect(out).toContain('全体をもっと簡潔に');
    expect(out).toContain(`.claude/hview/${sid}/turn-004.html`);
    expect(readPendingEdit(projectRoot, sid)?.owner).toBe('other-session');

    // 打ったセッションの次のターンで、置き場所が別でも予約は捨てる
    await runHookAs('other-session', 'user-prompt-submit', { prompt: 'ふつうの質問です' });
    expect(readPendingEdit(projectRoot, sid)).toBeNull();
  });

  test('特定できないセッション指定は案内だけにする', async () => {
    const out = await run('/hview edit zzzz/2');
    expect(out).toContain('セッションを特定できませんでした');
  });
});
