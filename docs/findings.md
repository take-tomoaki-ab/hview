# findings — 着手前の前提確認の結果

SPEC.md の「着手前に確認すること」5 項目を実機で確認した記録です。

- 確認日: 2026-08-12
- 環境: macOS (Darwin 23.6.0) / Claude Code 2.1.228 / Bun 1.3.10
- 結論: **5 項目とも前提は崩れていない。** ただし 2 点、設計に補足が必要な事実が見つかった（項目 4 の「スクロール位置」と項目 2 の「matcher の範囲」）。いずれも SPEC の方式を変えずに吸収できる範囲。

| 項目 | 結果 | 補足 |
| --- | --- | --- |
| 1. hook の入力仕様 | ✅ 前提どおり | `session_id` を取得できる |
| 2. PostToolUse の matcher | ✅ 前提どおり | `Write` で捕捉できる。`Edit` も足した |
| 3. 指示注入の効き目 | ✅ 前提どおり | 3 ターン試して全て遵守 |
| 4. iframe の制約 | ⚠️ 前提どおりだが要補足 | 親から iframe のスクロール位置が読めない |
| 5. port の選定 | ✅ 前提どおり | 5757 は空き |

---

## 1. hook の入力仕様 — セッション識別子は取得できる

### 確認方法

使い捨てのプロジェクトに `cat > capture.json` だけを行う hook を仕込み、`claude -p` を実際に走らせて
hook の stdin をそのまま保存した。

### 結果

`UserPromptSubmit` に渡る JSON のキーは次のとおり。

```
cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path
```

実際の値（抜粋）:

```json
{
  "session_id": "01234567-89ab-cdef-0123-456789abcdef",
  "cwd": "/private/tmp/.../hooktest",
  "prompt_id": "fedcba98-7654-3210-fedc-ba9876543210",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "hello.txt というファイルを作って中身を hi にして。それだけでいい。"
}
```

**`session_id` は UUID 形式で取得できる。`cwd` も取れるので、プロジェクトルートの解決にも使える。**
代替案の検討は不要。

### 判明した副次的な事実

- `prompt` がそのまま渡るので、`#html` のインラインマーク判定を hook 側だけで完結できる。
- `SessionStart` hook も `session_id` を返す（`source: "startup"` 付き）。今回は使っていない。
- **`cwd` は Claude Code を起動したディレクトリ**であって、必ずしもプロジェクトルートではない。
  `.claude` / `.git` を持つ最寄りの祖先まで遡って解決している（`src/paths.ts`）。
  なお **ホームディレクトリは走査対象から外す必要がある**。`~/.claude` が存在するため、
  素朴に遡ると全プロジェクトが `~/.claude/hview` を共有してしまう（実装中に踏んで修正済み）。

### 追加で確認したこと: `additionalContext` は効く

`UserPromptSubmit` hook の stdout に次の JSON を出すと、モデルにコンテキストとして届くことを確認した。

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "..." } }
```

何も出力しなければ素通しになる（モード OFF のときの挙動として利用している）。

---

## 2. PostToolUse の matcher — `Write` で捕捉でき、対象パスも取れる

### 確認方法

`matcher: "Write"` の PostToolUse hook を仕込み、`claude -p` でファイルを書かせて stdin を保存した。

### 結果

```json
{
  "session_id": "01234567-...",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/private/tmp/.../hooktest/hello.txt",
    "content": "hi"
  },
  "tool_response": { "type": "create", "filePath": "...", "structuredPatch": [], ... },
  "tool_use_id": "toolu_01AB...",
  "duration_ms": 2
}
```

**`tool_input.file_path` が絶対パスで取れる。`session_id` も同じ JSON に入っている**ので、
サーバへの通知に必要な情報はこれだけで揃う。

### 設計への補足

- matcher は **`Write|Edit|MultiEdit`** にした。同一ファイル更新モードでは、モデルが全体を書き直す
  （Write）とは限らず部分更新（Edit）を選ぶことがあるため。
- hook は `.claude/hview/<session>/<file>.html` への書き込み**以外は即 return** する。
  matcher が広いぶん、プロジェクト内の全書き込みで起動されるため。
- サーバが落ちていても hook は黙って終わる（`fetch` を try/catch + 1.5 秒タイムアウト）。
  hook がユーザーの作業を止めないことを優先した。取りこぼしは `hview serve` 起動時の
  再インデックス（`reindexAll`）で回収する。

---

## 3. 指示注入の効き目 — 「HTML の中身を本文に貼るな」は守られた

### 確認方法

実際の注入文（`src/instructions.ts` と同等の内容）を返す hook を仕込み、
図が欲しくなる質問を投げて、チャット本文の文字数と生成された HTML を突き合わせた。

### 結果

3 ターン試して、**3 ターンとも本文に HTML を貼らなかった。**

| ターン | 質問 | 本文 | 生成 HTML | 外部 URL | SVG |
| --- | --- | --- | --- | --- | --- |
| 単発テスト | REST API と GraphQL の違い | 795 バイト | 21,926 バイト | 0 件 | 3 個 |
| E2E 1 | TCP と UDP の違い | 773 バイト | 22,904 バイト | 0 件 | 3 個 |
| E2E 2 | QUIC も足して比較 | 769 バイト | 30,392 バイト | 0 件 | 5 個 |

- 本文はいずれも 3〜4 行の要約 + ファイル名のみ。**HTML の二重出力は起きなかった。**
- 「外部 CDN・外部フォント・外部画像を使わない」も守られた（`http(s)://` の参照が 0 件）。
- `prefers-color-scheme` も 3 件すべてに入っていた（ライト / ダーク両対応）。
- `<title>` も指示どおり付き、ターン履歴の見出しにそのまま使えた
  （例: 「TCP と UDP の違い整理」「TCP / UDP / QUIC 三者比較」）。

### 効いたと思われる書き方

理由を添えた項目は守られやすかった。特に次の 2 つ。

- 「本文と HTML の二重出力はトークンをそのまま二倍使うため、これがいちばん重要です」
- ファイル名を hook 側で採番して**指定**する（モデルに `<n>` を推測させない）

### 未検証

- 長い会話（10 ターン以上）を続けたときに遵守率が落ちるかは未確認。
- 「HTML を貼るな」が破られた場合の検知・再指示は実装していない。

---

## 4. iframe の制約 — スクリプトは動くが、親からスクロール位置は読めない

### 確認方法

`sandbox="allow-scripts"`（`allow-same-origin` なし）の iframe に、
localStorage / cookie / 親アクセス / 外部 fetch / 同一オリジン fetch を試すプローブ HTML を読み込ませ、
結果を `postMessage` で親に返させた。CSP は本実装と同じものを付けた。

検証は Chrome 151 をヘッドレスで起動し、CDP（`Runtime.evaluate`）で結果を読み出して行った。

### 結果

`sandbox="allow-scripts"`（`allow-same-origin` なし）の iframe から取れた値:

```json
{
  "inlineScript": true,
  "localStorage":  "THROW: SecurityError",
  "cookie":        "THROW: SecurityError",
  "parentAccess":  "BLOCKED: SecurityError",
  "origin":        "http://localhost:5799",
  "externalFetch": "BLOCKED: Failed to fetch",
  "sameOriginFetch": "BLOCKED: Failed to fetch"
}
```

親から見た結果:

```
parentCanReadIframeDoc: "null (blocked)"   // iframe.contentDocument が null
scroll:                 "scroll reported: 500"  // postMessage 経由の往復は成立する
```

**要点は 4 つ。**

1. **インラインスクリプトは動く。** 図の中で JS を使っても描画される。
2. **localStorage / cookie は SecurityError で落ちる。** opaque origin として扱われている。
3. **親へのアクセス（`parent.location`）は SecurityError で止まる。** 親も `contentDocument` が `null`。
   隔離は意図どおり効いている。
4. **fetch は外部・同一オリジンとも止まる。** CSP の `connect-src 'none'` が効いている。
   同一オリジンまで止まるのは意図どおり（プレビューがサーバを叩く必要はない）。

なお `location.origin` は `"http://localhost:5799"` を返した。文字列としては URL 由来の値が見えるが、
ストレージも親アクセスも遮断されているので、実質は opaque origin として振る舞っている。

**`postMessage` は双方向に通る。** 親 → iframe の `restoreScroll` を送ると `scrollTo` が実行され、
その結果のスクロール位置（500）が iframe → 親に返ってきた。

### 設計への補足（実装に反映済み）

`allow-same-origin` を付けない以上、**親から `iframe.contentDocument` も `contentWindow.scrollY` も読めない。**
SPEC の「スクロール位置は維持する」を素直に実装できないため、次の方式にした。

- サーバがプレビュー配信時（`GET /f/:session/:file`）にだけ、`</body>` の直前へ
  小さな橋渡しスクリプトを注入する（`src/bridge.ts`）。
- そのスクリプトは `scroll` を親へ `postMessage` し、親からの `restoreScroll` を受けて `scrollTo` する。
- **ディスク上の HTML には手を入れない。** ダウンロード（`GET /d/:session/:file`）と
  Desktop 保存は、注入していない元のファイルをそのまま返す。

印刷（PDF 化）も同じ経路で、親から `print` メッセージを送って iframe 内で `print()` を呼ぶ。
これには `sandbox` に `allow-modals` の追加が必要だったので付けている（`allow-same-origin` は付けていない）。

CSP は次のとおり（`src/bridge.ts`）。`connect-src 'none'` で外部通信を止め、
`img-src`/`font-src` を `data:` に限って外部読み込みを止めている。

```
default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
img-src data: blob:; font-src data:; connect-src 'none';
form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'
```

`script-src` に `'unsafe-inline'` を許しているのは、図の中のインラインスクリプトを動かすため。
iframe は opaque origin なので、動いても親や他オリジンには手が届かない。

### この方式が実際に効くことの確認

ビューアを実際に開いて、縦に長いターンを 960px スクロールした状態で同じファイルを書き換え、
`POST /api/notify` で更新を通知した。

```
選択中のターン            : ライブ更新の確認用ターン
スクロール後の報告値      : 960
（同じファイルを書き換えて通知）
更新後の見出し            : ライブ更新の確認用ターン（更新後）
更新後の報告値            : 960   ← 維持された
```

**内容が差し替わってもスクロール位置は維持された。**

---

## 5. port の選定 — 5757 は空いている

### 確認方法

```
$ lsof -nP -iTCP:5757 -sTCP:LISTEN
(出力なし)
```

### 結果

**既定の 5757 は空いていた。** 実際に `hview serve --port 5757` で起動し、
`http://localhost:5757/api/ping` が `{"app":"hview","port":5757,...}` を返すことを確認した。

### 実装した生存確認

- `hview serve` は起動前に 2 段階でチェックする。
  1. `GET /api/ping` が `{"app":"hview"}` を返す → 既に hview が動いている旨を出して終了
  2. `Bun.serve` で bind を試して失敗 → 別プロセスが使っている旨を出して終了
- port は `--port` で変更できる。実際に 5758 で 2 台目を起動し、
  別プロジェクトを同時に見られることを確認した。
- 起動した port と pid は `.claude/hview/server.json` に書く。
  hook はここから port を読むので、`--port` を変えても hook 側の設定変更は要らない。
  終了時（SIGINT / SIGTERM）に消す。

---

## 付録: 実機で通したエンドツーエンド

使い捨てのテストプロジェクトに `hview install-hooks` で hook を入れ、`claude -p` を 2 ターン回した。

```
hview on
  → mode.json { enabled: true }
claude -p "TCP と UDP の違いを整理して"
  → UserPromptSubmit hook が turn-001.html を指定して指示注入
  → モデルが .claude/hview/<session>/turn-001.html を Write
  → PostToolUse hook が POST /api/notify
  → サーバが index.json を更新し WebSocket で push
  → サーバログ: [hview] turn 1 — TCP と UDP の違い整理 (01234567)
claude -p -c "じゃあ QUIC も足して比較して"
  → turn-002.html（採番が正しく進んだ）
```

`hview mode single-file` に切り替えると、注入文のファイル名が `current.html` に変わることも確認した。

**ユーザーの `~/.claude/settings.json` と `~/.claude/skills/html` には一切書き込んでいない。**
検証はすべて使い捨てのテストプロジェクト配下の `.claude/settings.json` で行った。

## 付録: ビューアのブラウザ実機確認

ヘッドレス Chrome（CDP 経由）でビューアを開き、次を確認した。

| 確認項目 | 結果 |
| --- | --- |
| WebSocket 接続 | `#conn` が `dot dot--on` |
| ターン履歴の描画 | 2 件（タイトル・ファイル名とも正しい） |
| 初期表示 | 最新ターンの iframe が表示される |
| 親から iframe の中身が読めるか | `null (blocked)` — 意図どおり読めない |
| ライブ更新 | `POST /api/notify` の直後に見出しと iframe src が新ターンへ切り替わった |
| ピン留め | `aria-pressed=true` になり、次の通知では切り替わらず「ピン留め中のため切り替えません」のトーストが出た |
| ターン履歴クリック | 過去のターンに戻れた |
| モードトグル | ビューアの操作で `mode.json` の `enabled` が変わった |
| コンソールエラー | 0 件 |

スクリーンショットも撮って、日本語のレイアウト崩れ・文字の潰れがないことを目視した。

## 付録: 複数セッション時のビューア挙動（issue #3）

ヘッドレスでない Chrome（chrome-devtools MCP 経由）でビューアを開き、
使い捨てのセッションディレクトリを 2 つ（A / B）用意して `POST /api/notify` でターンの到着を再現した。

issue #3 の表がそのまま回帰テストの雛形になるので、同じ形で残す。

### 既定（追従 OFF）

| | 選択中 | 表示中の見出し | 未読マーカー | トースト |
| --- | --- | --- | --- | --- |
| ① 初期表示（A を選択） | A | A-1 | なし | — |
| ② **B が turn-002 を書いた直後** | **A のまま** | **A-1 のまま** | **セレクタに `● bbbbbbbb…`／バッジ「● 未読 1 セッション」** | **「セッション bbbbbbbb… に新しいターン「B-2 …」が届きました」＋「切り替え」ボタン** |
| ③ トーストの「切り替え」を押す | B | B-2 | 消える | — |
| ④ A を選び直してピン留め、B が書く | A のまま | **A-1 のまま** | 出る | 「…（ピン留め中のため切り替えません）」 |

修正前は ② ③ ④ のいずれでも通知もマーカーも出ず、気づく手段が「セレクタの並び順とターン数の変化」しかなかった。

### 追従 ON（セレクタ先頭の「⟳ 最新を自動で追う」）

| | 選択中 | 表示中の見出し | 未読マーカー |
| --- | --- | --- | --- |
| ⑤ B 表示中に **A が書く** | **A へ自動で移る** | A-2 | 出ない |
| ⑥ A 表示中に **B が書く** | **B へ自動で移る** | 出ない |
| ⑦ 追従 ON のままピン留めし、A が書く | B のまま | **B-2 のまま切り替わらない** | 出る（トーストにピン留めの旨） |

⑦ が受け入れ条件「ピン留め中は、どのセッション由来でもプレビューが切り替わらない」にあたる。

### その他

| 確認項目 | 結果 |
| --- | --- |
| 履歴クリックで過去ターンに戻れる | B の turn-001 へ戻れた |
| セッションをまたいでも履歴クリックが効く | B → A に切り替えたうえで A の turn-001 へ戻れた |
| 追従の設定がリロードをまたぐ | `localStorage['hview.follow']` に保存され、OFF/ON とも復元された |
| コンソールエラー | 0 件（途中で出た 404 は、検証スクリプトが未作成のファイルを notify したもので、ビューア由来ではない） |
| 日本語のレイアウト | 崩れ・文字潰れ・要素の重なりなし。未読バッジとセレクタ、トーストと「切り替え」ボタンの並びも目視で確認 |

## 付録: mode.json の同時書き込み（issue #3 の関連項目）

2 プロセスから同時に `enabled: true` と `outputMode: single-file` を書き、
結果が両方とも反映されているかを数えた。

| 実装 | 更新が失われた回数 |
| --- | --- |
| 修正前（読む → マージ → `writeFileSync`） | 60 回中 2 回 |
| 修正後（ロック ＋ 一時ファイル → `rename`） | 150 回中 0 回 |

失敗時の `mode.json` は JSON として壊れており（`Invalid control character`）、
`readMode` の `catch` が既定値に落ちて `enabled: true` が消える、という経路だった。
つまり issue の「一時ファイルに書いて rename」だけでも実測した失敗は塞がる。
ただし read-modify-write のレース自体は rename では直列化されないので、ロックも入れてある。
