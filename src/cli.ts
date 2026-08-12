#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runPostToolUseHook, runUserPromptSubmitHook } from './hooks.ts';
import {
  mergeSettings,
  readSettings,
  serialize,
  settingsPath,
  unifiedDiff,
  writeSettings,
  type Scope,
} from './install-hooks.ts';
import { DEFAULT_PORT, findProjectRoot, hviewRoot } from './paths.ts';
import { isPortTaken, pingServer, readServerInfo } from './server-info.ts';
import { reindexAll, startServer } from './server.ts';
import { listSessions, readMode, writeMode } from './state.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'hview');

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags.set(k!, v);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) flags.set(k!, argv[++i]!);
      else flags.set(k!, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const USAGE = `hview — Claude Code の回答を図つき HTML でライブ表示する

使い方:
  hview serve [--port 5757] [--open]   HTTP + WebSocket サーバを起動する
  hview open [--port 5757]             ビューアをブラウザで開く
  hview status                         サーバ・モード・セッションの状態を表示する
  hview on | off                       HTML モードを切り替える（mode.json）
  hview mode per-turn | single-file    出力モードを切り替える
  hview install-hooks [--user] [--yes] Claude Code に hook を登録する（差分を出して確認する）
  hview install-skill [--yes]          /hview スキルを ~/.claude/skills/hview に入れる（確認する）
  hview hook <event>                   hook 本体（Claude Code から呼ばれる。手で叩かない）

共通オプション:
  --dir <path>   プロジェクトルートを明示する（既定: .claude を持つ最寄りの祖先）
`;

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  // hook はプロセス起動のたびに走るので、余計な初期化の前に処理する
  if (command === 'hook') {
    const event = positional[1];
    if (event === 'user-prompt-submit') return runUserPromptSubmitHook();
    if (event === 'post-tool-use') return runPostToolUseHook();
    process.exit(0);
  }

  const projectRoot = findProjectRoot(
    typeof flags.get('dir') === 'string' ? (flags.get('dir') as string) : process.cwd(),
  );
  const port = Number(flags.get('port') ?? DEFAULT_PORT) || DEFAULT_PORT;

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(USAGE);
      return;

    case 'serve':
      return serve(projectRoot, port, flags.get('open') === true);

    case 'open':
      return openViewer(projectRoot, port);

    case 'status':
      return status(projectRoot, port);

    case 'on':
    case 'off': {
      const mode = writeMode(projectRoot, { enabled: command === 'on' });
      console.log(`HTML モード: ${mode.enabled ? 'ON' : 'OFF'}（${projectRoot}）`);
      await notifyServer(projectRoot, port);
      return;
    }

    case 'mode': {
      const value = positional[1];
      if (value !== 'per-turn' && value !== 'single-file') {
        console.error('hview mode per-turn | single-file');
        process.exit(1);
      }
      const mode = writeMode(projectRoot, { outputMode: value });
      console.log(`出力モード: ${mode.outputMode}`);
      await notifyServer(projectRoot, port);
      return;
    }

    case 'install-hooks':
      return installHooks(projectRoot, flags.get('user') === true ? 'user' : 'project', flags.get('yes') === true);

    case 'install-skill':
      return installSkill(flags.get('yes') === true);

    default:
      console.error(`不明なコマンド: ${command}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

async function serve(projectRoot: string, port: number, open: boolean) {
  if (await pingServer(port)) {
    console.error(`ポート ${port} では既に hview が動いています。http://localhost:${port} を開いてください。`);
    process.exit(1);
  }
  if (await isPortTaken(port)) {
    console.error(`ポート ${port} は hview 以外のプロセスが使っています。--port で別の番号を指定してください。`);
    process.exit(1);
  }

  const found = reindexAll(projectRoot);
  startServer({ projectRoot, port });

  const mode = readMode(projectRoot);
  console.log(`hview serve  http://localhost:${port}`);
  console.log(`  project    ${projectRoot}`);
  console.log(`  state      ${hviewRoot(projectRoot)}`);
  console.log(`  mode       ${mode.enabled ? 'ON' : 'OFF'} / ${mode.outputMode}`);
  console.log(`  既存の HTML ${found} 件を読み込みました`);
  if (open) await openUrl(`http://localhost:${port}`);
}

async function openViewer(projectRoot: string, port: number) {
  const info = readServerInfo(projectRoot);
  const target = info?.port ?? port;
  if (!(await pingServer(target))) {
    console.error(`hview サーバが見つかりません。先に \`hview serve\` を実行してください。`);
    process.exit(1);
  }
  await openUrl(`http://localhost:${target}`);
}

async function openUrl(url: string) {
  const cmd =
    process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  await Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).exited;
  console.log(`開きました: ${url}`);
}

async function status(projectRoot: string, port: number) {
  const info = readServerInfo(projectRoot);
  const target = info?.port ?? port;
  const alive = await pingServer(target);
  const mode = readMode(projectRoot);
  const sessions = listSessions(projectRoot);

  console.log(`project    ${projectRoot}`);
  console.log(`server     ${alive ? `動作中 http://localhost:${target} (pid ${info?.pid ?? '?'})` : '停止中'}`);
  console.log(`mode       ${mode.enabled ? 'ON' : 'OFF'} / ${mode.outputMode}`);
  console.log(`sessions   ${sessions.length} 件`);
  for (const s of sessions.slice(0, 5)) {
    console.log(`  ${s.sessionId}  最終更新 ${s.updatedAt}`);
  }

  for (const scope of ['project', 'user'] as Scope[]) {
    const p = settingsPath(scope, projectRoot);
    const installed = existsSync(p) && serialize(readSettings(p)).includes(`${BIN_PATH} hook`);
    console.log(`hooks      ${scope}: ${installed ? '登録済み' : '未登録'} (${p})`);
  }
}

async function notifyServer(projectRoot: string, port: number) {
  const target = readServerInfo(projectRoot)?.port ?? port;
  try {
    await fetch(`http://127.0.0.1:${target}/api/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(800),
    });
  } catch {
    // サーバ未起動なら何もしない。mode.json は既に更新済み
  }
}

async function installHooks(projectRoot: string, scope: Scope, assumeYes: boolean) {
  const path = settingsPath(scope, projectRoot);
  const current = readSettings(path);
  const { next, added, alreadyPresent } = mergeSettings(current, BIN_PATH);

  console.log(`対象ファイル: ${path}`);
  if (scope === 'user') {
    console.log('※ ユーザー設定です。すべてのプロジェクトに影響します。');
  }
  for (const a of alreadyPresent) console.log(`  既に登録済み: ${a}`);

  if (added.length === 0) {
    console.log('追加する hook はありません。');
    return;
  }

  const before = existsSync(path) ? serialize(current) : '';
  console.log('\n--- 追加される hook ---');
  for (const a of added) console.log(`  ${a}`);
  console.log('\n--- 差分 ---');
  console.log(unifiedDiff(before, serialize(next), path));
  console.log('');

  if (!assumeYes) {
    const ok = await confirm('この内容で書き込みますか？ [y/N] ');
    if (!ok) {
      console.log('中止しました。設定ファイルは変更していません。');
      return;
    }
  }

  if (existsSync(path)) {
    const backup = `${path}.hview-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await Bun.write(backup, before);
    console.log(`バックアップ: ${backup}`);
  }
  writeSettings(path, next);
  console.log(`書き込みました: ${path}`);
  console.log('Claude Code を再起動すると hook が有効になります。');
}

async function installSkill(assumeYes: boolean) {
  const src = join(REPO_ROOT, 'skills', 'hview', 'SKILL.md');
  const dest = join(homedir(), '.claude', 'skills', 'hview', 'SKILL.md');
  const content = await Bun.file(src).text();

  console.log(`インストール元: ${src}`);
  console.log(`インストール先: ${dest}`);
  console.log(existsSync(dest) ? '※ 既にファイルがあります。上書きします。' : '※ 新規に作成します。');
  console.log('※ 既存の ~/.claude/skills/html には触れません。');
  console.log('\n--- 書き込む内容 ---');
  console.log(content);

  if (!assumeYes) {
    const ok = await confirm('この内容で書き込みますか？ [y/N] ');
    if (!ok) {
      console.log('中止しました。何も変更していません。');
      return;
    }
  }

  if (existsSync(dest)) {
    const backup = `${dest}.hview-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await Bun.write(backup, await Bun.file(dest).text());
    console.log(`バックアップ: ${backup}`);
  }
  await Bun.write(dest, content);
  console.log(`書き込みました: ${dest}`);
  console.log('Claude Code を再起動すると /hview が使えるようになります。');
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

await main();
