import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Comment } from './comments.ts';
import type { OutputMode } from './state.ts';

const TEMPLATE_PATH = join(homedir(), '.claude', 'skills', 'html', 'assets', 'template.html');

export type InjectionInput = {
  sessionId: string;
  relPath: string;
  outputMode: OutputMode;
  /** `#html` によるそのターンだけの起動か、mode.json による継続起動か、`/hview edit` か */
  trigger: 'inline' | 'mode' | 'edit';
  port: number;
  /** trigger が edit のときだけ。作り直す元の版と、反映させるコメント */
  edit?: { sourceRelPath: string; comments: Comment[] };
};

/**
 * UserPromptSubmit hook が additionalContext として渡す本文。
 * 「HTML の中身を本文に貼らない」が守られるかどうかがトークン消費を左右するので、
 * 理由込みで明示している。
 */
export function buildInjection(input: InjectionInput): string {
  const { sessionId, relPath, outputMode, trigger, port, edit } = input;
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

  if (edit) lines.push(...editSection(edit), '');

  if (existsSync(TEMPLATE_PATH) && !edit) {
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
  // edit のプロンプトは `/hview edit` なので、この但し書きを入れると HTML を書かなくなる
  if (!edit) {
    lines.push(
      'このターンのプロンプトが hview 自体の操作（モードの ON/OFF、出力モードの変更、状態確認）なら、' +
        'HTML は書かずに実行結果だけを簡潔に答えてください。' +
        'モードを切る操作でそのターンだけ HTML が残るのは分かりにくいためです。',
    );
  }
  lines.push(
    trigger === 'inline'
      ? '今回は `#html` によるこのターン限りの指定です。次のターンは通常のテキスト回答に戻してください。'
      : trigger === 'edit'
        ? '今回は `/hview edit` によるこのターン限りの作り直しです。次のターンの形式は hview モードの設定に従ってください。'
        : 'hview モードが ON の間、以降のターンも同じ形式で回答してください。',
  );
  lines.push(`（session: ${sessionId}）`);
  lines.push('</hview-instructions>');

  return lines.join('\n');
}

/**
 * `/hview edit` のときに足す節。
 * 見た目の土台（template.html）は元の版がすでに踏襲しているので読ませない。
 * 読ませると、コメントの無い箇所までテンプレートに寄せて書き直しがちになる。
 */
function editSection(edit: { sourceRelPath: string; comments: Comment[] }): string[] {
  const lines: string[] = [];
  lines.push('## このターンは作り直し（/hview edit）');
  lines.push('');
  lines.push(
    `ユーザーがビューア上で \`${edit.sourceRelPath}\` にコメントを付けました。` +
      'まずこのファイルを Read し、コメントを反映した新しい版を上の書き出し先に Write してください。',
  );
  lines.push('');
  lines.push('- 元のファイルは書き換えないでください。版を比べられるように残します。');
  lines.push('- コメントが付いていない箇所は、構成・文言・スタイルを元のまま保ってください。');
  lines.push(
    '- 要素の特定には `selector` だけでなく `html`（outerHTML の先頭）と `text` を使ってください。' +
      'selector は実行時の DOM から取ったもので、ソースとずれることがあります。',
  );
  lines.push('- `target` が「ページ全体」のコメントは、HTML 全体に対する要望です。');
  lines.push(
    '- チャット本文には、コメントごとに「どう直したか」を 1 行ずつだけ書いてください。' +
      '反映できなかったコメントがあれば理由を添えてください。',
  );
  lines.push('');
  lines.push('### コメント');
  lines.push('');
  edit.comments.forEach((c, i) => {
    lines.push(`${i + 1}. ${quoteBody(c.body)}`);
    if (!c.target) {
      lines.push('   - target: ページ全体');
      return;
    }
    const t = c.target;
    lines.push(`   - selector: \`${t.selector}\``);
    if (t.heading) lines.push(`   - 見出し: ${t.heading}`);
    if (t.text) lines.push(`   - text: ${JSON.stringify(t.text)}`);
    if (t.html) lines.push(`   - html: ${JSON.stringify(t.html)}`);
  });
  return lines;
}

/** 複数行のコメントを番号付きリストの中に収める。 */
function quoteBody(body: string): string {
  return body.replace(/\r?\n/g, '\n   ');
}

/** `/hview edit` を打ったのに、反映すべきコメントが無いとき。 */
export function buildNoCommentsNotice(input: {
  requested: string | null;
  /** empty: 対象にコメントが無い / session: 指定されたセッションが特定できない */
  reason: 'empty' | 'session';
  port: number;
  others: { sessionId: string; file: string; count: number }[];
}): string {
  const { requested, reason, port, others } = input;
  const what =
    reason === 'session'
      ? `\`${requested}\` のセッションを特定できませんでした（該当なし、または先頭一致が複数）。`
      : requested
        ? `\`${requested}\` に未反映のコメントはありません。`
        : 'このセッションに未反映のコメントはありません。';
  const lines = ['<hview-instructions>', `\`/hview edit\` が実行されましたが、${what}`];
  if (others.length) {
    lines.push(
      'ただし別のセッションの版に未反映のコメントがあります。' +
        'ビューアで別セッションの HTML を見ながらコメントした可能性が高いので、そのことを伝え、' +
        '反映したい場合は次のコマンドを実行するよう案内してください。HTML は書かないでください。',
    );
    for (const o of others) {
      const turn = /^turn-(\d+)\.html$/.exec(o.file);
      const ref = `${o.sessionId.slice(0, 8)}/${turn ? Number(turn[1]) : o.file.replace(/\.html$/, '')}`;
      lines.push(`- \`/hview edit ${ref}\` … ${o.file}（${o.count} 件）`);
    }
  } else {
    lines.push(
      'HTML は書かずに、そのことだけを 1〜2 行で伝えてください。' +
        `あわせて、ビューア（http://localhost:${port}）の「💬 コメント」から要素を選んでコメントを付けてから、` +
        'もう一度 `/hview edit` を実行するよう案内してください。',
    );
  }
  lines.push('</hview-instructions>');
  return lines.join('\n');
}

/**
 * `/hview edit` かどうか。当てはまれば引数（対象の版の指定。無ければ null）を返す。
 * 他の操作コマンドと違ってこのターンは HTML を書かせたいので、先に判定して分岐させる。
 */
export function parseHviewEditPrompt(prompt: string): { arg: string | null } | null {
  const m = /^\s*\/?hview\s+edit(?=$|[\s、。!?！？:：])[\s:：]*(\S*)/i.exec(prompt);
  if (!m) return null;
  return { arg: m[1] ? m[1] : null };
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

/**
 * hview 自体を操作するターンかどうか。
 * `UserPromptSubmit` hook はスキルが `hview off` を実行する前に走るので、
 * mode.json だけを見ると「OFF にするターン」にまで指示を注入してしまう。
 * `/hview off` `hview status` `hview mode single-file` のように
 * 先頭が hview で始まるプロンプトを、注入の対象から外すための判定。
 *
 * `hviewer` や `hview.ts` のような別語には反応させたくないので、
 * 直後は空白・文末・句読点に限る。ドットは `hview.ts` を巻き込むため入れない。
 */
export function isHviewControlPrompt(prompt: string): boolean {
  return /^\s*\/?hview(?=$|[\s、。!?！？:：])/i.test(prompt);
}
