---
name: hview
description: Claude Code の回答を図つき単一ファイル HTML で返すモード（hview）を ON / OFF する。また「/hview edit」で、ビューア上で付けたコメントを反映した新しい版の HTML を作る。「/hview on」「/hview off」「/hview edit」「hview を有効にして」「HTML モードを切って」などで起動する。ブラウザの hview ビューアに回答がライブ表示される。
---

# hview モードの切り替え

このスキルは `.claude/hview/mode.json` を書き換えるだけです。実際の指示注入は Claude Code の
`UserPromptSubmit` hook が行います。

## 使い方

ユーザーの意図に応じて、次のコマンドを Bash ツールで実行してください。

| ユーザーの言い方 | 実行するコマンド |
| --- | --- |
| `/hview on` / 「hview を ON に」「HTML モードにして」 | `hview on` |
| `/hview off` / 「hview を OFF に」「もう HTML はいい」 | `hview off` |
| `/hview` / 「今どうなってる？」 | `hview status` |
| 「毎ターン新しいファイルにして」 | `hview mode per-turn` |
| 「同じファイルを更新して」 | `hview mode single-file` |
| `/hview edit` / `/hview edit turn-003` | コマンドは実行しない（下の「コメントの反映」を参照） |

`hview` コマンドが PATH に無い場合は、リポジトリの `bin/hview` を絶対パスで叩いてください。

## コメントの反映（`/hview edit`）

ビューアの「💬 コメント」で HTML の要素やページ全体に付けたコメントを、新しい版の HTML に反映します。
対象の版、コメントの一覧、書き出し先は `UserPromptSubmit` hook が `<hview-instructions>` として注入します。
**このスキルからコマンドを実行したり、comments.json を自分で読みに行ったりせず、注入された指示に従ってください。**
モデルは自分の session_id を知らないため、どのセッションのコメントかを自力では正しく決められません。

注入が見当たらない場合は hook が未登録です。`hview install-hooks` を実行して Claude Code を再起動するよう案内してください。

## 実行したあとに伝えること

- ON にしたとき: 「次のターンから HTML で返します」と伝える。
  `hview status` で `server 停止中` と出たら、`hview serve` を別ターミナルで起動するよう案内する。
- OFF にしたとき: 「通常のテキスト回答に戻します」と伝える。

## 注意

- このスキルは状態を切り替えるだけです。HTML の書き出し方は hook が注入する指示に従ってください。
- 単発で 1 回だけ HTML がほしい場合は、モードを触らずにプロンプトへ `#html` と書けば足ります。
- 単発の書き出しだけで、ライブ表示が不要なときは既存の `/html` スキルを使ってください。
