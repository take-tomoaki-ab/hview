import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isHviewControlPrompt } from './instructions.ts';

const CLI = join(import.meta.dir, 'cli.ts');
let projectRoot: string;

/** hook 本体は stdin の JSON で動くので、実際にプロセスを起こして流し込む。 */
async function runHook(prompt: string): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', CLI, 'hook', 'user-prompt-submit'], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: 'test-session',
        cwd: projectRoot,
        hook_event_name: 'UserPromptSubmit',
        prompt,
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
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
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
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
