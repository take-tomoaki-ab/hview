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
 * サーバが落ちていても黙って終わる（hook がユーザーの作業を止めないため）。
 */
export async function runPostToolUseHook(): Promise<void> {
  const payload = await readStdin();
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;

  const projectRoot = findProjectRoot(payload.cwd ?? process.cwd());
  const parsed = parseHviewPath(projectRoot, filePath);
  if (!parsed) return;

  const port = resolvePort(projectRoot);
  try {
    await fetch(`http://127.0.0.1:${port}/api/notify`, {
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
  }
}
