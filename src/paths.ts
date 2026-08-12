import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const HVIEW_DIRNAME = 'hview';
export const DEFAULT_PORT = 5757;
export const DEFAULT_EXPORT_DIR = join(homedir(), 'Desktop', 'codes', 'html-output');

/**
 * プロジェクトルートを決める。
 * 1. `.claude` か `.git` を持つ一番近い祖先
 * 2. 見つからなければ start そのもの（初回はまだどちらも無いため）
 *
 * ホームディレクトリは走査対象から外す。`~/.claude` は Claude Code のユーザー設定であり、
 * ここを掴むと全プロジェクトの HTML が `~/.claude/hview` に混ざってしまう。
 */
export function findProjectRoot(start: string = process.cwd()): string {
  const home = resolve(homedir());
  let dir = resolve(start);
  for (;;) {
    if (dir === home) break;
    if (existsSync(join(dir, '.claude')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

export function hviewRoot(projectRoot: string): string {
  return join(projectRoot, '.claude', HVIEW_DIRNAME);
}

export function modeFile(projectRoot: string): string {
  return join(hviewRoot(projectRoot), 'mode.json');
}

export function sessionDir(projectRoot: string, sessionId: string): string {
  return join(hviewRoot(projectRoot), sessionId);
}

export function indexFile(projectRoot: string, sessionId: string): string {
  return join(sessionDir(projectRoot, sessionId), 'index.json');
}

/** `.claude/hview/<session>/<file>.html` への書き込みかどうかを判定する。 */
export function parseHviewPath(
  projectRoot: string,
  filePath: string,
): { sessionId: string; file: string } | null {
  if (!isAbsolute(filePath)) return null;
  const root = hviewRoot(projectRoot) + sep;
  if (!filePath.startsWith(root)) return null;
  const rest = filePath.slice(root.length).split(sep);
  if (rest.length !== 2) return null;
  const [sessionId, file] = rest;
  if (!sessionId || !file || !file.endsWith('.html')) return null;
  if (!isSafeSegment(sessionId) || !isSafeSegment(file)) return null;
  return { sessionId, file };
}

/** パストラバーサル避け。セッション ID とファイル名に許すのは英数字・ハイフン・アンダースコア・ドットのみ。 */
export function isSafeSegment(segment: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(segment) && !segment.includes('..');
}
