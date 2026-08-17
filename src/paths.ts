import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

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

/**
 * プロジェクトをまたぐ情報の置き場。
 * ここに置くのは「どのポートでサーバが動いているか」と「どのプロジェクトを見たか」だけで、
 * HTML やターン一覧はプロジェクト側（`<project>/.claude/hview/`）に置いたままにする。
 *
 * `HVIEW_STATE_DIR` で差し替えられる。テストが本物の `~/.claude` を汚さないための口で、
 * 呼ばれるたびに読むので、プロセス起動後に設定しても効く。
 */
export function userHviewRoot(): string {
  return process.env.HVIEW_STATE_DIR || join(homedir(), '.claude', HVIEW_DIRNAME);
}

/** 起動中サーバの共通レジストリ。`server.json` が無いプロジェクトからでもポートを引けるようにする。 */
export function serversFile(): string {
  return join(userHviewRoot(), 'servers.json');
}

/** ビューアが扱ったプロジェクトの一覧。サーバを再起動しても他プロジェクトを見失わないため。 */
export function projectsFile(): string {
  return join(userHviewRoot(), 'projects.json');
}

/**
 * URL に載せるプロジェクト識別子。
 * projectRoot をそのまま URL に入れると、受け取った文字列でファイルを読むことになる。
 * ハッシュにしておけば、サーバは「自分が知っている projectRoot」への写像しか持たないので、
 * 外から任意のパスを指させられない。
 */
export function projectId(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
}

/** ビューアに出す短い表示名。`.../codes/hview` → `hview`。 */
export function projectLabel(projectRoot: string): string {
  return basename(projectRoot) || projectRoot;
}

/**
 * hook から受け取った projectRoot を正規化する。
 * 絶対パスでなければ捨て、`..` は resolve で畳む。ホームディレクトリそのものも受け付けない
 * （`~/.claude/hview` は全プロジェクトの混ざり先になるため。findProjectRoot と揃えている）。
 */
export function normalizeProjectRoot(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) return null;
  const root = resolve(value);
  if (root === resolve(homedir())) return null;
  return root;
}

/**
 * サーバが受け入れてよい projectRoot かどうか。
 * `.claude/hview` が既にあることを要求する。hook は HTML を書いた後にしか通知しないので、
 * 正規の経路なら必ず存在する。これがパストラバーサルと「知らない場所への書き込み」の両方を塞ぐ。
 */
export function isHviewProjectRoot(projectRoot: string): boolean {
  return existsSync(hviewRoot(projectRoot));
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
