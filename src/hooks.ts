import { relative } from 'node:path';
import { buildInjection, hasInlineMark, isHviewControlPrompt } from './instructions.ts';
import { findProjectRoot, parseHviewPath } from './paths.ts';
import { resolvePort } from './server-info.ts';
import { nextTurnFile, readMode } from './state.ts';

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
 */
export async function runUserPromptSubmitHook(): Promise<void> {
  const payload = await readStdin();
  const sessionId = payload.session_id;
  if (!sessionId) return;

  const prompt = payload.prompt ?? '';
  if (isHviewControlPrompt(prompt)) return;

  const projectRoot = findProjectRoot(payload.cwd ?? process.cwd());
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

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
    })}\n`,
  );
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
