import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { commentsFile, hviewRoot, isSafeSegment, pendingEditFile, sessionDir } from './paths.ts';
import { recordTurn, turnNumberOf, withFileLock, writeJsonAtomic } from './state.ts';

/**
 * ビューアのインスペクターで選んだ要素の手がかり。
 * 実行時の DOM とソースはズレうる（HTML 内スクリプトによる生成、配信時に注入する bridge など）ので、
 * セレクタ 1 本に頼らず、Claude が Grep で当てられる材料を複数持たせる。
 */
export type CommentTarget = {
  selector: string;
  tag: string;
  /** textContent の先頭。空白は詰める */
  text: string;
  /** outerHTML の先頭 */
  html: string;
  /** 直前の見出し。どの章の話かを掴ませるため */
  heading: string;
};

export type Comment = {
  id: string;
  /** コメントを付けた版のファイル名 */
  file: string;
  /** null はページ全体へのコメント */
  target: CommentTarget | null;
  body: string;
  status: 'open' | 'applied';
  /** 反映した版のファイル名 */
  appliedIn: string | null;
  createdAt: string;
};

export type PendingEdit = {
  /** `/hview edit` を打ったセッション。別セッションの版を作り直すときは置き場所と異なる */
  owner: string;
  source: string;
  output: string;
  commentIds: string[];
  createdAt: string;
};

const LIMITS = { body: 4000, selector: 600, tag: 40, text: 200, html: 600, heading: 200 };

export function readComments(projectRoot: string, sessionId: string): Comment[] {
  try {
    const raw = JSON.parse(readFileSync(commentsFile(projectRoot, sessionId), 'utf8')) as {
      comments?: Comment[];
    };
    return Array.isArray(raw.comments) ? raw.comments : [];
  } catch {
    return [];
  }
}

/** 読む → 変える → 書くを、サーバと hook の間で直列化する。 */
function updateComments<T>(
  projectRoot: string,
  sessionId: string,
  fn: (comments: Comment[]) => T,
): T {
  mkdirSync(sessionDir(projectRoot, sessionId), { recursive: true });
  const dest = commentsFile(projectRoot, sessionId);
  return withFileLock(dest, () => {
    const comments = readComments(projectRoot, sessionId);
    const result = fn(comments);
    writeJsonAtomic(dest, { comments });
    return result;
  });
}

export function addComment(
  projectRoot: string,
  sessionId: string,
  input: { file: string; target: unknown; body: unknown },
): Comment | null {
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, LIMITS.body) : '';
  if (!body) return null;
  const comment: Comment = {
    id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    file: input.file,
    target: sanitizeTarget(input.target),
    body,
    status: 'open',
    appliedIn: null,
    createdAt: new Date().toISOString(),
  };
  updateComments(projectRoot, sessionId, (comments) => comments.push(comment));
  return comment;
}

export function deleteComment(projectRoot: string, sessionId: string, id: string): boolean {
  return updateComments(projectRoot, sessionId, (comments) => {
    const i = comments.findIndex((c) => c.id === id);
    if (i === -1) return false;
    comments.splice(i, 1);
    return true;
  });
}

function sanitizeTarget(raw: unknown): CommentTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (k: keyof typeof LIMITS) => (typeof r[k] === 'string' ? (r[k] as string).slice(0, LIMITS[k]) : '');
  const target = {
    selector: str('selector'),
    tag: str('tag'),
    text: str('text'),
    html: str('html'),
    heading: str('heading'),
  };
  return target.selector ? target : null;
}

/**
 * `/hview edit` の対象にする版を決める。
 * 指定があればそれ、無ければ未反映コメントを持つ版のうち一番新しいもの。
 */
export function resolveEditSource(
  comments: Comment[],
  requested: string | null,
): { source: string; open: Comment[] } | null {
  const open = comments.filter((c) => c.status === 'open');
  if (requested) {
    const hits = open.filter((c) => c.file === requested);
    return hits.length ? { source: requested, open: hits } : null;
  }
  if (!open.length) return null;
  const latest = open.reduce((best, c) => (isNewer(c, best) ? c : best));
  return { source: latest.file, open: open.filter((c) => c.file === latest.file) };
}

function isNewer(a: Comment, b: Comment): boolean {
  const na = turnNumberOf(a.file) ?? -1;
  const nb = turnNumberOf(b.file) ?? -1;
  if (na !== nb) return na > nb;
  return a.createdAt > b.createdAt;
}

/**
 * `/hview edit` の引数。
 * - `turn-003` / `3` … 自セッションの版
 * - `e38a32c3/turn-002` / `e38a32c3/2` … 別セッションの版（セッション ID は先頭一致）
 * - `e38a32c3/` … 別セッションの一番新しい版
 * ファイル名として解釈できない語（「試しに…」などの自由文）は指定なしとして扱う。
 */
export function parseEditArg(arg: string | null): { sessionPrefix: string | null; file: string | null } {
  if (!arg) return { sessionPrefix: null, file: null };
  const slash = arg.indexOf('/');
  if (slash === -1) return { sessionPrefix: null, file: normalizeTurnArg(arg) };
  const prefix = arg.slice(0, slash);
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) return { sessionPrefix: null, file: null };
  return { sessionPrefix: prefix, file: normalizeTurnArg(arg.slice(slash + 1)) };
}

/** セッション ID の先頭一致。候補が 1 つに絞れたときだけ返す。 */
export function resolveSessionPrefix(projectRoot: string, prefix: string): string | null {
  const hits = sessionIds(projectRoot).filter((id) => id.startsWith(prefix));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

function sessionIds(projectRoot: string): string[] {
  try {
    return readdirSync(hviewRoot(projectRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSegment(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 自セッション以外で未反映コメントが残っている版。`/hview edit` の空振り時の案内に使う。 */
export function otherOpenComments(
  projectRoot: string,
  exceptSessionId: string,
): { sessionId: string; file: string; count: number }[] {
  const out: { sessionId: string; file: string; count: number }[] = [];
  for (const sessionId of sessionIds(projectRoot)) {
    if (sessionId === exceptSessionId) continue;
    const counts = new Map<string, number>();
    for (const c of readComments(projectRoot, sessionId)) {
      if (c.status === 'open') counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
    }
    for (const [file, count] of counts) out.push({ sessionId, file, count });
  }
  return out;
}

/** `turn-003` / `turn-003.html` / `3` を `turn-003.html` に揃える。解釈できなければ null。 */
export function normalizeTurnArg(arg: string): string | null {
  const s = arg.trim();
  if (!s) return null;
  // `current.html` 以外の拡張子なしの英単語まで版とみなすと、自由文の英語を拾ってしまう
  if (s === 'current') return 'current.html';
  if (/^turn-\d+$/.test(s)) return `${s}.html`;
  if (/^\d+$/.test(s)) return `turn-${s.padStart(3, '0')}.html`;
  if (/^[A-Za-z0-9_-]+\.html$/.test(s)) return s;
  return null;
}

export function writePendingEdit(projectRoot: string, sessionId: string, pending: PendingEdit): void {
  mkdirSync(sessionDir(projectRoot, sessionId), { recursive: true });
  writeJsonAtomic(pendingEditFile(projectRoot, sessionId), pending);
}

export function readPendingEdit(projectRoot: string, sessionId: string): PendingEdit | null {
  try {
    return JSON.parse(readFileSync(pendingEditFile(projectRoot, sessionId), 'utf8')) as PendingEdit;
  } catch {
    return null;
  }
}

/**
 * edit のターンで書かせるはずだったファイル名は、次の通常ターンの採番と重なる。
 * 書かれないまま残すと、通常ターンの書き込みを「反映した」と誤認するので捨てる。
 */
export function clearPendingEdit(projectRoot: string, sessionId: string): void {
  removeQuietly(pendingEditFile(projectRoot, sessionId));
}

/** owner が打った edit の予約を、置き場所のセッションによらずすべて捨てる。 */
export function clearPendingEditsOf(projectRoot: string, owner: string): void {
  for (const sessionId of sessionIds(projectRoot)) {
    const pending = readPendingEdit(projectRoot, sessionId);
    if (pending && (pending.owner ?? sessionId) === owner) clearPendingEdit(projectRoot, sessionId);
  }
}

function removeQuietly(p: string): void {
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // 消せなくても次の edit で上書きされる
  }
}

/**
 * edit の出力が書かれたら、元にしたコメントを反映済みにし、ターンに元の版を記録する。
 * 戻り値は反映済みにしたコメント数。対象外の書き込みなら 0。
 */
export function settlePendingEdit(projectRoot: string, sessionId: string, file: string): number {
  const pending = readPendingEdit(projectRoot, sessionId);
  if (!pending || pending.output !== file) return 0;
  const ids = new Set(pending.commentIds);
  const count = updateComments(projectRoot, sessionId, (comments) => {
    let n = 0;
    for (const c of comments) {
      if (ids.has(c.id) && c.status === 'open') {
        c.status = 'applied';
        c.appliedIn = file;
        n++;
      }
    }
    return n;
  });
  recordTurn(projectRoot, sessionId, file, { revisionOf: pending.source });
  clearPendingEdit(projectRoot, sessionId);
  return count;
}
