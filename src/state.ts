import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { hviewRoot, indexFile, modeFile, sessionDir } from './paths.ts';

export type OutputMode = 'per-turn' | 'single-file';

export type Mode = {
  /** ON の間、UserPromptSubmit hook が毎ターン指示を注入する */
  enabled: boolean;
  outputMode: OutputMode;
  updatedAt: string;
};

export type Turn = {
  n: number;
  file: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionIndex = {
  sessionId: string;
  turns: Turn[];
};

const DEFAULT_MODE: Mode = {
  enabled: false,
  outputMode: 'per-turn',
  updatedAt: new Date(0).toISOString(),
};

export function readMode(projectRoot: string): Mode {
  try {
    const raw = JSON.parse(readFileSync(modeFile(projectRoot), 'utf8')) as Partial<Mode>;
    return {
      enabled: raw.enabled === true,
      outputMode: raw.outputMode === 'single-file' ? 'single-file' : 'per-turn',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : DEFAULT_MODE.updatedAt,
    };
  } catch {
    return { ...DEFAULT_MODE };
  }
}

/**
 * mode.json は「読む → マージ → 書く」なので、複数セッションから同時に叩くと
 * 片方の更新が消える。ロックで読み書きを直列化し、書き込み自体も
 * 一時ファイル → rename にして、途中の状態を他プロセスに読ませない。
 */
export function writeMode(projectRoot: string, patch: Partial<Omit<Mode, 'updatedAt'>>): Mode {
  mkdirSync(hviewRoot(projectRoot), { recursive: true });
  return withModeLock(projectRoot, () => {
    const next: Mode = {
      ...readMode(projectRoot),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const dest = modeFile(projectRoot);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, dest);
    return next;
  });
}

const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 20;

/**
 * `open(..., 'wx')` を排他の要にした素朴なロック。
 * 取れないまま 1 秒待ったらロック無しで進める。プロセスがロックを持ったまま死んでも
 * 詰まらせないためで、その場合の最悪は従来と同じ挙動に戻るだけ。
 */
function withModeLock<T>(projectRoot: string, fn: () => T): T {
  const lock = `${modeFile(projectRoot)}.lock`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      sleepSync(LOCK_WAIT_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // 誰かに消されていても困らない
      }
    }
  }
  return fn();
}

/** hook は同期処理なので、await せずに待てる手段がいる。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readIndex(projectRoot: string, sessionId: string): SessionIndex {
  try {
    const raw = JSON.parse(readFileSync(indexFile(projectRoot, sessionId), 'utf8')) as SessionIndex;
    if (!Array.isArray(raw.turns)) throw new Error('broken index');
    return { sessionId, turns: raw.turns };
  } catch {
    return { sessionId, turns: [] };
  }
}

export function writeIndex(projectRoot: string, index: SessionIndex): void {
  mkdirSync(sessionDir(projectRoot, index.sessionId), { recursive: true });
  writeFileSync(indexFile(projectRoot, index.sessionId), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * 書き込まれた HTML を index.json に反映する。既出のファイルなら updatedAt だけ更新する。
 * 戻り値は反映後のターン。
 */
export function recordTurn(projectRoot: string, sessionId: string, file: string): Turn {
  const index = readIndex(projectRoot, sessionId);
  const now = new Date().toISOString();
  const title = readTitle(join(sessionDir(projectRoot, sessionId), file)) ?? file;

  const existing = index.turns.find((t) => t.file === file);
  let turn: Turn;
  if (existing) {
    existing.title = title;
    existing.updatedAt = now;
    turn = existing;
  } else {
    turn = {
      n: turnNumberOf(file) ?? index.turns.length + 1,
      file,
      title,
      createdAt: now,
      updatedAt: now,
    };
    index.turns.push(turn);
  }
  index.turns.sort((a, b) => a.n - b.n);
  writeIndex(projectRoot, index);
  return turn;
}

/** `turn-003.html` → 3。数字を含まないファイル名は null。 */
export function turnNumberOf(file: string): number | null {
  const m = /^turn-(\d+)\.html$/.exec(file);
  return m?.[1] ? Number(m[1]) : null;
}

/** 次に書かせるファイル名を決める。ここで採番しておくとモデルに推測させずに済む。 */
export function nextTurnFile(projectRoot: string, sessionId: string, mode: OutputMode): string {
  if (mode === 'single-file') return 'current.html';
  const index = readIndex(projectRoot, sessionId);
  const max = index.turns.reduce((acc, t) => Math.max(acc, turnNumberOf(t.file) ?? 0), 0);
  return `turn-${String(max + 1).padStart(3, '0')}.html`;
}

export function readTitle(htmlPath: string): string | null {
  try {
    // タイトルはたいてい先頭にあるので、巨大な HTML でも頭だけ読めば足りる
    const head = readFileSync(htmlPath, 'utf8').slice(0, 8192);
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    if (!m?.[1]) return null;
    return decodeEntities(m[1].trim()).slice(0, 200) || null;
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `.claude/hview/` 直下のセッションディレクトリを、更新が新しい順に並べて返す。 */
export function listSessions(projectRoot: string): { sessionId: string; updatedAt: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(hviewRoot(projectRoot), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .map((sessionId) => {
      const turns = readIndex(projectRoot, sessionId).turns;
      const updatedAt = turns.reduce((acc, t) => (t.updatedAt > acc ? t.updatedAt : acc), '');
      return { sessionId, updatedAt };
    })
    .filter((s) => s.updatedAt !== '')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
