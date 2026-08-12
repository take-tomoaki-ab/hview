import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Scope = 'project' | 'user';

type HookEntry = { type: 'command'; command: string; timeout?: number };
type HookMatcher = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookMatcher[]> } & Record<string, unknown>;

export const HOOK_MARK = 'hview hook';

export function settingsPath(scope: Scope, projectRoot: string): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(projectRoot, '.claude', 'settings.json');
}

function hookCommand(binPath: string, sub: string): string {
  return `${binPath} ${sub}`;
}

/** 追加したい hook 定義。command に bin の絶対パスを埋めるので、リポジトリを移動したら入れ直す。 */
export function desiredHooks(binPath: string): Record<string, HookMatcher[]> {
  return {
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: hookCommand(binPath, 'hook user-prompt-submit'), timeout: 10 }] },
    ],
    PostToolUse: [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [{ type: 'command', command: hookCommand(binPath, 'hook post-tool-use'), timeout: 10 }],
      },
    ],
  };
}

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch (e) {
    throw new Error(`${path} が JSON として読めませんでした: ${(e as Error).message}`);
  }
}

/**
 * 既存設定を保ったまま hview の hook だけを足した設定を作る。
 * 既に同じ command が入っていれば何もしない（重複登録を避ける）。
 */
export function mergeSettings(
  current: Settings,
  binPath: string,
): { next: Settings; added: string[]; alreadyPresent: string[] } {
  const next: Settings = JSON.parse(JSON.stringify(current));
  next.hooks = next.hooks ?? {};
  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const [event, matchers] of Object.entries(desiredHooks(binPath))) {
    const list = (next.hooks[event] = next.hooks[event] ?? []);
    for (const matcher of matchers) {
      const cmd = matcher.hooks[0]!.command;
      const exists = list.some((m) => m.hooks?.some((h) => h.command === cmd));
      if (exists) {
        alreadyPresent.push(`${event}: ${cmd}`);
        continue;
      }
      list.push(matcher);
      added.push(`${event}${matcher.matcher ? ` (matcher: ${matcher.matcher})` : ''}: ${cmd}`);
    }
  }
  return { next, added, alreadyPresent };
}

export function serialize(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** 行単位の素朴な差分。外部依存を増やさないための最小実装。 */
export function unifiedDiff(before: string, after: string, label: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- ${label} (現在)`, `+++ ${label} (適用後)`];

  // 共通の先頭・末尾を削って、変化した範囲だけを出す
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const ctx = 3;
  const from = Math.max(0, head - ctx);
  for (let i = from; i < head; i++) out.push(`  ${a[i]}`);
  for (let i = head; i < a.length - tail; i++) out.push(`- ${a[i]}`);
  for (let i = head; i < b.length - tail; i++) out.push(`+ ${b[i]}`);
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + ctx); i++) {
    out.push(`  ${a[i]}`);
  }
  return out.join('\n');
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, serialize(settings));
}
