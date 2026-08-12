---
name: hview
description: Claude Code の回答を図つき単一ファイル HTML で返すモード（hview）を ON / OFF する。「/hview on」「/hview off」「hview を有効にして」「HTML モードを切って」などで起動する。ブラウザの hview ビューアに回答がライブ表示される。
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

`hview` コマンドが PATH に無い場合は、リポジトリの `bin/hview` を絶対パスで叩いてください。

## 実行したあとに伝えること

- ON にしたとき: 「次のターンから HTML で返します」と伝える。
  `hview status` で `server 停止中` と出たら、`hview serve` を別ターミナルで起動するよう案内する。
- OFF にしたとき: 「通常のテキスト回答に戻します」と伝える。

## 注意

- このスキルは状態を切り替えるだけです。HTML の書き出し方は hook が注入する指示に従ってください。
- 単発で 1 回だけ HTML がほしい場合は、モードを触らずにプロンプトへ `#html` と書けば足ります。
- 単発の書き出しだけで、ライブ表示が不要なときは既存の `/html` スキルを使ってください。
