import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OutputMode } from './state.ts';

const TEMPLATE_PATH = join(homedir(), '.claude', 'skills', 'html', 'assets', 'template.html');

export type InjectionInput = {
  sessionId: string;
  relPath: string;
  outputMode: OutputMode;
  /** `#html` によるそのターンだけの起動か、mode.json による継続起動か */
  trigger: 'inline' | 'mode';
  port: number;
};

/**
 * UserPromptSubmit hook が additionalContext として渡す本文。
 * 「HTML の中身を本文に貼らない」が守られるかどうかがトークン消費を左右するので、
 * 理由込みで明示している。
 */
export function buildInjection(input: InjectionInput): string {
  const { sessionId, relPath, outputMode, trigger, port } = input;
  const lines: string[] = [];

  lines.push('<hview-instructions>');
  lines.push(
    'このターンの回答は、ターミナルの本文ではなく「図つきの単一ファイル HTML」を主役にしてください。' +
      `ブラウザの hview ビューア（http://localhost:${port}）が、書き出した HTML を自動で表示します。`,
  );
  lines.push('');
  lines.push('## 必ず守ること');
  lines.push('');
  lines.push(
    `1. 回答の実体は単一ファイルの HTML として、Write ツールで \`${relPath}\` に書き出してください。` +
      (outputMode === 'single-file'
        ? '（同一ファイル更新モードです。既存の内容を踏まえて全体を書き直してください）'
        : '（毎ターン新規モードです。ファイル名は指定どおりにしてください）'),
  );
  lines.push(
    '2. チャット本文には **2〜3 行の要約とファイル名だけ** を書いてください。' +
      'HTML のタグ・CSS・SVG のソースを本文に貼らないでください。' +
      '本文と HTML の二重出力はトークンをそのまま二倍使うため、これがいちばん重要です。',
  );
  lines.push(
    '3. 比較・フロー・前後差分・構造は、文章で説明せずに **インライン SVG の図** にしてください。' +
      '表で足りるものは表で構いませんが、「読めば分かる」ではなく「見れば分かる」を優先してください。',
  );
  lines.push(
    '4. **外部 CDN・外部フォント・外部画像・外部スクリプトを一切使わないでください。**' +
      'オフラインで開ける単一ファイルであることが必須です。画像が要る場合は SVG を直接書いてください。',
  );
  lines.push('5. ライトテーマ / ダークテーマの両方で読めるようにしてください。');
  lines.push(
    '6. `<title>` を必ず書いてください。ビューアのターン履歴にそのまま並びます。' +
      '内容が分かる 20 字前後の日本語にしてください。',
  );
  lines.push('');

  if (existsSync(TEMPLATE_PATH)) {
    lines.push('## 見た目の土台');
    lines.push('');
    lines.push(
      `\`${TEMPLATE_PATH}\` を読んで、その CSS とマークアップ規約を土台にしてください。` +
        '既存の `/html` スキルの出力と見た目を揃えるためです。',
    );
    lines.push('');
  }

  lines.push('## 注意');
  lines.push('');
  lines.push(
    'HTML の中でスクリプトを動かす場合、ビューアの iframe は `sandbox="allow-scripts"` で ' +
      '`allow-same-origin` を付けずに隔離されます。' +
      'localStorage・cookie・fetch は使えません。図の描画は SVG と CSS だけで完結させてください。',
  );
  lines.push(
    trigger === 'inline'
      ? '今回は `#html` によるこのターン限りの指定です。次のターンは通常のテキスト回答に戻してください。'
      : 'hview モードが ON の間、以降のターンも同じ形式で回答してください。',
  );
  lines.push(`（session: ${sessionId}）`);
  lines.push('</hview-instructions>');

  return lines.join('\n');
}

/**
 * プロンプト中の `#html` マーク。
 * 日本語は分かち書きしないので「整理して#html」のように空白無しで続くのを拾いたい。
 * 一方で `#htmltag` や URL の `page#html` には反応させたくないため、
 * 前後が英数字のときだけ除外する。
 */
export function hasInlineMark(prompt: string): boolean {
  return /(?<![A-Za-z0-9_#])#html(?![A-Za-z0-9_-])/i.test(prompt);
}
