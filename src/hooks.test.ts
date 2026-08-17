import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isHviewControlPrompt } from './instructions.ts';

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
