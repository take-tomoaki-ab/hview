import { relative } from 'node:path';
import {
  clearPendingEditsOf,
  otherOpenComments,
  parseEditArg,
  readComments,
  resolveSessionPrefix,
  resolveEditSource,
  settlePendingEdit,
  writePendingEdit,
} from './comments.ts';
import {
  buildInjection,
  buildNoCommentsNotice,
  hasInlineMark,
  isHviewControlPrompt,
  parseHviewEditPrompt,
} from './instructions.ts';
import { findProjectRoot, parseHviewPath, sessionDir } from './paths.ts';
import { resolvePort } from './server-info.ts';
import { nextPerTurnFile, nextTurnFile, readMode } from './state.ts';

type HookPayload = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
};

async function readStdin(): Promise<HookPayload> {
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? (JSON.parse(text) as HookPayload) : {};
  } catch {
    return {};
  }
}

/**
 * UserPromptSubmit hook。
 * mode.json が ON か、プロンプトに `#html` があるときだけ additionalContext を返す。
 * それ以外は何も出力しない（= 素通し）。
 *
 * ただし hview 自体を操作するターンは例外で、常に素通しする。
 * この hook はスキルが `hview off` を走らせる前に評価されるため、
 * mode.json だけを見ていると OFF にするターンにまで注入してしまう。
 *
 * `/hview edit` だけは操作コマンドの中で唯一 HTML を書かせるターンなので、先に分岐する。
 * コメントを取りに行くのをスキルに任せないのは、モデルが自分の session_id を知らないため。
 */
export async function runUserPromptSubmitHook(): Promise<void> {
  const payload = await readStdin();
  const sessionId = payload.session_id;
  if (!sessionId) return;

  const prompt = payload.prompt ?? '';
  const projectRoot = findProjectRoot(payload.cwd ?? process.cwd());

  const edit = parseHviewEditPrompt(prompt);
  if (edit) {
    emit(buildEditContext(projectRoot, sessionId, edit.arg));
    return;
  }
  // edit 以外のターンに入ったら、書かれずに終わった edit の予約は捨てる
  clearPendingEditsOf(projectRoot, sessionId);

  if (isHviewControlPrompt(prompt)) return;

  const mode = readMode(projectRoot);
  const inline = hasInlineMark(prompt);
  if (!mode.enabled && !inline) return;

  const file = nextTurnFile(projectRoot, sessionId, mode.outputMode);
  const relPath = relative(projectRoot, `${projectRoot}/.claude/hview/${sessionId}/${file}`);

  const additionalContext = buildInjection({
    sessionId,
    relPath,
    outputMode: mode.outputMode,
    trigger: inline && !mode.enabled ? 'inline' : 'mode',
    port: resolvePort(projectRoot),
  });

  emit(additionalContext);
}

function emit(additionalContext: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    })}\n`,
  );
}

/**
 * `/hview edit` の注入文を組み立てる。
 * 既定は自セッションのコメントだけを見る。別セッションは `<session>/<turn>` で明示されたときだけ扱い、
 * 空振りしたときは別セッションに残っているコメントを案内する（黙って無視すると、
 * ビューアで別セッションの版を見ながらコメントした人が原因に気づけない）。
 */
function buildEditContext(projectRoot: string, owner: string, arg: string | null): string {
  const port = resolvePort(projectRoot);
  clearPendingEditsOf(projectRoot, owner);

  const parsed = parseEditArg(arg);
  let target = owner;
  if (parsed.sessionPrefix) {
    const resolved = resolveSessionPrefix(projectRoot, parsed.sessionPrefix);
    if (!resolved) {
      return buildNoCommentsNotice({
        requested: `${parsed.sessionPrefix}/${parsed.file ?? ''}`,
        reason: 'session',
        port,
        others: otherOpenComments(projectRoot, owner),
      });
    }
    target = resolved;
  }

  const resolved = resolveEditSource(readComments(projectRoot, target), parsed.file);
  if (!resolved) {
    return buildNoCommentsNotice({
      requested: parsed.file,
      reason: 'empty',
      port,
      others: target === owner ? otherOpenComments(projectRoot, owner) : [],
    });
  }

  // single-file モードでも新しいファイルに書かせる。上書きすると元の版と比べられない。
  // 置き場所は元の版と同じセッション。ビューアで元の版の隣に並べ、revisionOf を辿れるようにする
  const output = nextPerTurnFile(projectRoot, target);
  const dir = relative(projectRoot, sessionDir(projectRoot, target));
  writePendingEdit(projectRoot, target, {
    owner,
    source: resolved.source,
    output,
    commentIds: resolved.open.map((c) => c.id),
    createdAt: new Date().toISOString(),
  });

  return buildInjection({
    sessionId: owner,
    relPath: `${dir}/${output}`,
    outputMode: 'per-turn',
    trigger: 'edit',
    port,
    edit: { sourceRelPath: `${dir}/${resolved.source}`, comments: resolved.open },
  });
}
/**
 * PostToolUse hook（matcher: Write|Edit|MultiEdit）。
 * `.claude/hview/<session>/<file>.html` への書き込みだけをサーバへ通知する。
 *
 * サーバが落ちているときは黙って終わる（hook がユーザーの作業を止めないため）。
 * ただしサーバが応答したうえで受け取りを断った場合は stderr に出す。
 * HTML は書けているのにビューアに出ない状態を無音で済ませると、
 * ユーザーからは「HTML が書き出されなかった」ようにしか見えない。
 */
export async function runPostToolUseHook(): Promise<void> {
  const payload = await readStdin();
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;

  const projectRoot = findProjectRoot(payload.cwd ?? process.cwd());
  const parsed = parseHviewPath(projectRoot, filePath);
  if (!parsed) return;

  // サーバが落ちていても反映済みの記録は残したいので、通知より先に hook 自身で片付ける
  settlePendingEdit(projectRoot, parsed.sessionId, parsed.file);

  const port = resolvePort(projectRoot);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectRoot,
        sessionId: parsed.sessionId,
        file: parsed.file,
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // サーバ未起動。ファイルは書けているので次に serve したときに拾える
    return;
  }

  if (res.ok) return;

  const detail = await res.text().catch(() => '');
  process.stderr.write(
    `[hview] HTML は書き出せましたが、ビューアへの通知が拒否されました（HTTP ${res.status}）。\n` +
      `  file:   ${filePath}\n` +
      `  server: http://127.0.0.1:${port}\n` +
      (detail ? `  detail: ${detail.slice(0, 300)}\n` : '') +
      `  このプロジェクトで \`hview serve\` を起動するか、ビューアの「再読込」を押してください。\n`,
  );
  // 非 0 で終わると Claude Code が stderr をユーザーに見せる。無音で落とさないための 1
  process.exitCode = 1;
}
