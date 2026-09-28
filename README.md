# hview

Claude Code の回答を「図つきの単一ファイル HTML」として受け取り、ブラウザで常時表示しながら対話を続けるためのローカルツールです。

ターミナルの横にブラウザを 1 枚置いておくと、会話を続けている間ずっと最新の図が出ている状態になります。

```
プロンプト（#html マーク）
  → UserPromptSubmit hook が「HTML で返せ」の指示を注入
  → Claude Code が .claude/hview/<session-id>/turn-<n>.html を Write
  → PostToolUse hook が hview サーバに通知
  → サーバが WebSocket でブラウザに push
  → ビューアが自動更新（スクロール位置は維持）
```

- 設計の全体像: [`docs/SPEC.md`](docs/SPEC.md) / [`docs/plan.html`](docs/plan.html)
- 前提確認の記録: [`docs/findings.md`](docs/findings.md)

## 必要なもの

- [Bun](https://bun.sh) 1.3 以上（`.tool-versions` は 1.3.10）
- Claude Code
- ブラウザ（Chrome など）

外部 CDN・外部フォント・外部画像には一切依存しません。オフラインで動きます。

## セットアップ

### 1. 依存を入れる

```bash
cd /path/to/hview
bun install
```

`bin/hview` は bun を自前で探すので、PATH に通しておくと楽です。

```bash
ln -s "$(pwd)/bin/hview" ~/.local/bin/hview   # リポジトリ直下で実行する
hview help
```

**リンク元は必ず絶対パスにしてください。** `ln -s ./bin/hview ~/.local/bin/hview` のように
相対パスで張ると、`ln` は文字列をそのまま保存し、**リンク自身の置き場所からの相対**として
解決します（この例では `~/.local/bin/bin/hview` を探しに行く）。リンク切れになると
PATH 探索から除外されるため、`hview: command not found` ではなく
「`command -v hview` が何も返さない」という分かりにくい形で失敗します。

```bash
ls -l ~/.local/bin/hview   # 向き先がリポジトリの絶対パスになっていることを確認する
```

### 2. hook を登録する

HTML を使いたいプロジェクトで実行します。

```bash
cd /path/to/your-project
hview install-hooks
```

- 書き込む前に**対象ファイルと差分を表示して確認を求めます**。`n` で中止できます。
- 既存の設定は保ったまま hook だけを足します。同じ hook が既にあれば重複登録しません。
- 上書き前にバックアップ（`settings.json.hview-backup-<時刻>`）を取ります。
- 既定はプロジェクト設定（`<project>/.claude/settings.json`）です。
  全プロジェクトで使いたい場合は `--user` を付けると `~/.claude/settings.json` が対象になりますが、
  影響範囲が広いので普段はプロジェクト設定を勧めます。
  `--user` で入れた場合、`hview serve` はどこか 1 プロジェクトで起動しておけば足ります
  （[1 つのビューアで複数プロジェクトを見る](#1-つのビューアで複数プロジェクトを見る)）。

登録後、Claude Code を再起動すると hook が有効になります。

### 3. `/hview` スキルを入れる（任意）

`/hview on` / `/hview off` で切り替えたい場合だけ実行します。

```bash
hview install-skill
```

`~/.claude/skills/hview/SKILL.md` に書き込みます。こちらも**書き込む内容を表示して確認を求めます**。
既存の `~/.claude/skills/html` には触れません。

## 使い方

### サーバを起動してブラウザを開く

プロジェクトのディレクトリで、ターミナルをもう 1 枚開いて実行します。

```bash
hview serve --open
```

```
hview serve  http://localhost:5757
  project    /path/to/your-project
  state      /path/to/your-project/.claude/hview
  mode       OFF / per-turn
```

port を変えたいときは `--port 5758`。起動した port は `.claude/hview/server.json` と
`~/.claude/hview/servers.json`（プロジェクト横断のレジストリ）に記録され、hook はそこから読むので、
hook 側の設定を直す必要はありません。

### 1 つのビューアで複数プロジェクトを見る

`hview serve` はどこか 1 プロジェクトで起動すれば足ります。**別のプロジェクトで書き出した HTML も、
同じビューアに出ます。**

```
hview serve  http://localhost:5757
  project    /path/to/your-project          ← serve を起動したプロジェクト
  ...
  他プロジェクト journey-web-event (/path/to/journey-web-event)
```

- hook は書き出し元の projectRoot を通知に載せ、サーバはプロジェクトごとに状態を持ちます。
- プロジェクトが 2 つ以上になると、上部に**プロジェクト名のチップ**が出て、セッションセレクタが
  プロジェクトごとの見出し（`optgroup`）で束ねられます。
- 「HTML モード」「出力モード」は**選択中のセッションのプロジェクト**に効きます（`mode.json` はプロジェクトごと）。
- 通知先の port は、そのプロジェクトに `server.json` が無くても共通レジストリから引きます。
  `--port` を変えて起動していても届きます。
- 一度ターンを受けたプロジェクトは `~/.claude/hview/projects.json` に残るので、サーバを再起動しても
  ビューアから消えません。

`hview status` の `servers` 行に、起動中のサーバと「どこへ通知が飛ぶか」が出ます。

### HTML で返させる

3 通りあります。どれも最終的には同じ hook 経由で動きます。

| 方法 | 操作 | 有効範囲 |
| --- | --- | --- |
| インラインマーク | プロンプトに `#html` と書く | そのターンだけ |
| CLI / スキル | `hview on` / `hview off`（`/hview on`） | 解除するまで |
| ビューアのトグル | 画面右上の「HTML モード」 | 解除するまで |

```
> この設計の選択肢を比較して #html
```

Claude Code はチャット本文に 2〜3 行の要約とファイル名だけを書き、実体を
`.claude/hview/<session-id>/turn-001.html` に書き出します。ブラウザは自動で更新されます。

`/hview off` や `hview status` のように hview 自体を操作するターンには、モードが ON でも
指示を注入しません。モードを切る操作でそのターンだけ HTML が残ると分かりにくいためです。

### ビューアの操作

| 場所 | できること |
| --- | --- |
| 左サイドバー | 過去のターンに戻る。「さっきの比較表もう一回」を会話なしで解決する |
| プロジェクト名のチップ | 表示中のターンがどのプロジェクトのものかを示す（複数プロジェクトを扱っているときだけ出る） |
| セッションセレクタ | 表示するセッションを選ぶ。各セッションは**最新ターンの HTML タイトル**で並ぶ（長いものは省略、`<title>` が無ければ短縮した session-id）。完全なタイトルと session-id はホバーで出る。複数プロジェクトのときはプロジェクトごとの見出しで束ねる。先頭の「⟳ 最新を自動で追う」を選ぶと、新しいターンが届いたセッションへ自動で切り替わる |
| ● 未読バッジ | 選択していないセッションに新しいターンが届いたときに出る。押すとそのセッションへ移る |
| 📌 ピン留め | 表示中の HTML を固定する。どのセッションの新しいターンが来ても切り替わらない |
| ⬇ ダウンロード | HTML をそのまま保存する（自己完結なので配っても開ける） |
| 💾 Desktop へ保存 | `~/Desktop/codes/html-output/YYYYMMDD-HHMM-<タイトル>.html` に保存する |
| 📋 パス | 絶対パスをクリップボードにコピーする |
| 🖨 印刷 | 印刷ダイアログを開く（PDF 化はここから） |
| 右上のトグル | HTML モードの ON/OFF（**選択中セッションのプロジェクト**に効く） |
| 出力モード | 毎ターン新規 / 同一ファイル更新（同じくプロジェクト単位） |

**同一ファイル更新モード**にすると、書き出し先が `current.html` に固定されます。
「今の図のここを直して」がそのまま成立するので、1 枚の図を詰めていくときに使います。

### 同じプロジェクトで複数の Claude セッションを動かす

書き出し先は `.claude/hview/<session-id>/` とセッションごとに分かれるので、ファイルは混ざりません。
ビューアは既定では**選択中のセッションを勝手に切り替えません**。
他セッションがターンを書いたときは、未読バッジ・セレクタの `●`・「切り替え」ボタン付きの通知で知らせます。

常に最新を見たいなら、セッションセレクタで「⟳ 最新を自動で追う」を選んでください。この設定はブラウザに保存されます。
どちらの場合も、ピン留め中は切り替わりません。

なお HTML モード（`mode.json`）は**プロジェクトに 1 つ**で、セッション間で共有されます。
片方のセッションで `hview on` すると、もう片方にも効きます。

## コマンド

```
hview serve [--port 5757] [--open]   HTTP + WebSocket サーバを起動する
hview open [--port 5757]             ビューアをブラウザで開く
hview status                         サーバ・モード・セッション・hook の状態を表示する
hview on | off                       HTML モードを切り替える
hview mode per-turn | single-file    出力モードを切り替える
hview install-hooks [--user] [--yes] hook を登録する（差分を出して確認する）
hview install-skill [--yes]          /hview スキルを入れる（内容を出して確認する）
hview hook <event>                   hook 本体（Claude Code から呼ばれる。手で叩かない）

共通オプション:
  --dir <path>   プロジェクトルートを明示する（既定: .claude / .git を持つ最寄りの祖先）
```

## 置かれるファイル

```
<project>/.claude/hview/
├── mode.json                 # ON/OFF と出力モード（プロジェクトごと）
├── server.json               # 起動中の port と pid（サーバ終了時に消える）
└── <session-id>/
    ├── index.json            # ターン一覧（番号・タイトル・時刻・ファイル名）
    ├── turn-001.html
    └── turn-002.html

~/.claude/hview/
├── servers.json              # 起動中サーバのレジストリ（port / pid / projectRoot）
└── projects.json             # ビューアが扱ったプロジェクトの一覧
```

HTML とターン一覧はプロジェクト側にしか置きません。`~/.claude/hview/` に入るのは
「どこにサーバがいるか」「どのプロジェクトを見たか」だけです。
置き場所を変えたいときは環境変数 `HVIEW_STATE_DIR` で差し替えられます。

`.gitignore` に `.claude/hview/` を入れておくのを勧めます。

## セキュリティ

プレビューは以下で隔離しています。

- `sandbox="allow-scripts allow-modals"` の iframe（**`allow-same-origin` は付けない**）。
  localStorage・cookie・親フレームへのアクセスはすべて SecurityError で止まります。
- CSP `connect-src 'none'` で fetch / XHR / WebSocket を止め、`img-src` / `font-src` を `data:` に限定。
  外部への通信が発生しないことを実機で確認済みです（[`docs/findings.md`](docs/findings.md) の項目 4）。
- サーバは `127.0.0.1` にのみ bind します。
- `.claude/hview/<session>/<file>.html` 以外のパスは配信しません（`..` を含むパスは 404）。
- 通知で受け取った projectRoot は、絶対パスであること・`..` を畳んだうえで `.claude/hview` が
  実在することを確かめてから採用します。URL には projectRoot ではなくそのハッシュ（`projectId`）を載せるので、
  ビューア側から任意のパスを指させることはできません。

親から iframe の中身は読めないため、スクロール位置の維持だけはサーバが配信時に
小さな `postMessage` スクリプトを注入して実現しています。**ディスク上の HTML は書き換えません。**
ダウンロードと Desktop 保存は、注入していない元のファイルをそのまま返します。

## トラブルシューティング

| 症状 | 対応 |
| --- | --- |
| ブラウザが更新されない | `hview status` でサーバが動いているか確認する。止まっていれば `hview serve` |
| サーバを止めている間の分が出ない | ビューア左上の「再読込」を押す（知っているプロジェクトすべてを走査して index を作り直す） |
| 別プロジェクトの HTML が出ない | `hview status` の `servers` 行で通知先を確認する。`[hview] ... 通知が拒否されました` が出ていればその内容に従う |
| `ポート 5757 は hview 以外のプロセスが使っています` | `--port` で別の番号を指定する |
| hook が動かない | `hview status` の `hooks` 行を確認する。登録後は Claude Code の再起動が必要 |
| HTML が書かれず本文で返ってくる | モードが ON か確認する（`hview status`）。`#html` の直後に英数字が続くと反応しない（`#htmltag` は不可、`#htmlで` は可） |

## やらないこと

- 既存の `~/.claude/skills/html` スキルの変更・削除。単発の書き出しは従来どおり `/html`、
  常時表示は `hview` という住み分けです。
- `~/.claude/settings.json` の無断書き換え。`install-hooks` / `install-skill` は必ず確認を取ります。
- 外部 CDN・外部フォント・外部画像への依存。

## 実装状況

SPEC.md の Phase 0〜2 まで実装済みです。Phase 3（プレビュー内の要素を選んで指示を返す逆方向フィードバック、
VS Code Webview 版フロントエンド）には着手していません。
