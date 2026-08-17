// hview ビューア。フレームワークは使わない。
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    conn: $('conn'),
    session: $('session'),
    unread: $('unread'),
    modeToggle: $('modeToggle'),
    outputMode: $('outputMode'),
    turns: $('turns'),
    emptyHint: $('emptyHint'),
    currentTitle: $('currentTitle'),
    pin: $('pin'),
    download: $('download'),
    export: $('export'),
    copyPath: $('copyPath'),
    print: $('print'),
    reindex: $('reindex'),
    preview: $('preview'),
    placeholder: $('placeholder'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastAction: $('toastAction'),
  };

  /** セッションセレクタの先頭に置く「追従」用の値。セッション ID は英数字系のみなので衝突しない。 */
  const FOLLOW = '__follow__';
  const FOLLOW_KEY = 'hview.follow';

  /** @type {{projectRoot:string, mode:any, sessions:any[], exportDir:string}|null} */
  let state = null;
  let sessionId = null;
  let currentFile = null;
  let pinned = false;
  /** ON の間、新しいターンが届いたセッションへ自動で移る。既定は OFF（読んでいる画面をさらわない） */
  let follow = readFollow();
  /** まだ見ていないターンが届いたセッションの ID。切り替えたら消す。 */
  const unread = new Set();
  /** ファイルごとのスクロール位置。iframe は opaque origin なので親からは読めず、
   *  bridge スクリプトの postMessage で受け取った値をここに溜める。 */
  const scrollMemory = new Map();
  let pendingRestore = null;

  // ---------- 通信 ----------

  function connect() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.addEventListener('open', () => setConn(true));
    ws.addEventListener('close', () => {
      setConn(false);
      setTimeout(connect, 1200);
    });
    ws.addEventListener('error', () => ws.close());
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.state) applyState(msg.state, msg);
    });
  }

  function setConn(ok) {
    el.conn.className = 'dot ' + (ok ? 'dot--on' : 'dot--off');
    el.conn.title = ok ? 'サーバに接続中' : 'サーバと切断されました';
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  // ---------- 状態の反映 ----------

  function applyState(next, msg) {
    state = next;
    el.modeToggle.checked = !!state.mode.enabled;
    el.outputMode.value = state.mode.outputMode;

    // 未選択のまま、あるいは消えたセッションを指したまま turn を受けると
    // 「見ている当のセッション」を他人扱いしてしまう。判定の前に現実へ合わせておく
    if (!sessionId || !state.sessions.some((s) => s.sessionId === sessionId)) {
      sessionId = state.sessions.length ? state.sessions[0].sessionId : null;
    }

    // 追従・未読の判定はセレクタを描く前に済ませる。ここで sessionId が動きうる
    const turn = msg && msg.type === 'turn' ? msg : null;
    if (turn) routeTurn(turn);

    renderSessions();
    const session = currentSession();
    renderTurns(session);

    if (!session) { showPlaceholder(); return; }

    // 選択中セッションに新しいターンが来たとき。ピン留め中は切り替えない
    if (turn && turn.sessionId === session.sessionId) {
      if (pinned && currentFile && currentFile !== turn.turn.file) {
        toast(`新しいターン「${turn.turn.title}」が届きました（ピン留め中のため切り替えません）`);
      } else {
        show(turn.turn.file, { keepScroll: turn.turn.file === currentFile });
      }
      return;
    }

    if (!currentFile || !session.turns.some((t) => t.file === currentFile)) {
      const last = session.turns[session.turns.length - 1];
      if (last) show(last.file);
      else showPlaceholder();
    } else {
      markCurrent();
    }
  }

  /**
   * 届いたターンの扱いを決める。
   * - 選択中セッション: 未読を落とすだけ（表示の更新は applyState 側）
   * - 追従中かつピン留めなし: そのセッションへ選択を移す
   * - それ以外: 未読マーカーを立て、切り替えボタン付きのトーストで知らせる
   */
  function routeTurn(msg) {
    if (msg.sessionId === sessionId) {
      unread.delete(msg.sessionId);
      return;
    }
    if (follow && !pinned) {
      sessionId = msg.sessionId;
      currentFile = null; // 別セッションのファイルなのでスクロール位置は引き継がない
      unread.delete(msg.sessionId);
      return;
    }
    unread.add(msg.sessionId);
    const why = pinned ? '（ピン留め中のため切り替えません）' : '';
    toast(
      `セッション ${short(msg.sessionId)} に新しいターン「${msg.turn.title}」が届きました${why}`,
      { label: '切り替え', run: () => selectSession(msg.sessionId) },
    );
  }

  function currentSession() {
    if (!state || !state.sessions.length) return null;
    return state.sessions.find((s) => s.sessionId === sessionId) || state.sessions[0];
  }

  function renderSessions() {
    const sessions = state.sessions;
    if (!sessions.length) {
      el.session.innerHTML = '<option>セッションなし</option>';
      renderUnread();
      return;
    }
    const followLabel = `⟳ 最新を自動で追う（${short(sessionId)}）`;
    const options = [
      `<option value="${FOLLOW}"${follow ? ' selected' : ''}>${esc(followLabel)}</option>`,
      ...sessions.map((s) => {
        const mark = unread.has(s.sessionId) ? '● ' : '';
        const label = `${mark}${short(s.sessionId)} (${s.turns.length} ターン)`;
        const selected = !follow && s.sessionId === sessionId ? ' selected' : '';
        return `<option value="${esc(s.sessionId)}"${selected}>${esc(label)}</option>`;
      }),
    ];
    el.session.innerHTML = options.join('');
    renderUnread();
  }

  /** セレクタは畳まれていると未読が見えないので、隣にバッジも出す。 */
  function renderUnread() {
    const n = state ? state.sessions.filter((s) => unread.has(s.sessionId)).length : 0;
    el.unread.hidden = n === 0;
    el.unread.textContent = `● 未読 ${n} セッション`;
  }

  function short(id) { return id ? `${id.slice(0, 8)}…` : '—'; }

  /** セレクタの値（セッション ID か FOLLOW）を選択として適用する。 */
  function selectSession(value) {
    if (!state) return;
    if (value === FOLLOW) {
      follow = true;
      const latest = state.sessions[0];
      if (latest && latest.sessionId !== sessionId) {
        sessionId = latest.sessionId;
        currentFile = null;
      }
      unread.clear();
      toast('新しいターンが届いたセッションへ自動で切り替えます');
    } else {
      follow = false;
      if (value !== sessionId) {
        sessionId = value;
        currentFile = null;
      }
      unread.delete(value);
    }
    saveFollow();
    applyState(state);
  }

  function renderTurns(session) {
    const turns = session ? session.turns : [];
    el.emptyHint.hidden = turns.length > 0;
    el.turns.innerHTML = turns
      .slice()
      .reverse()
      .map((t) => {
        const time = new Date(t.updatedAt).toLocaleTimeString('ja-JP', {
          hour: '2-digit',
          minute: '2-digit',
        });
        return `<li><button type="button" data-file="${esc(t.file)}">
          <span class="t__title">${esc(t.title)}</span>
          <span class="t__meta">#${t.n} · ${time} · ${esc(t.file)}</span>
        </button></li>`;
      })
      .join('');
    markCurrent();
  }

  function markCurrent() {
    for (const b of el.turns.querySelectorAll('button')) {
      b.setAttribute('aria-current', String(b.dataset.file === currentFile));
    }
    const session = currentSession();
    const turn = session && session.turns.find((t) => t.file === currentFile);
    el.currentTitle.textContent = turn ? `${turn.title}` : '—';
  }

  function show(file, opts) {
    const session = currentSession();
    if (!session) return showPlaceholder();
    const keepScroll = !!(opts && opts.keepScroll);
    pendingRestore = keepScroll ? scrollMemory.get(key(session.sessionId, file)) || 0 : 0;
    currentFile = file;
    el.preview.hidden = false;
    el.placeholder.hidden = true;
    // 同じ URL でも確実に読み直させたいのでキャッシュバスターを付ける
    el.preview.src = `/f/${encodeURIComponent(session.sessionId)}/${encodeURIComponent(file)}?t=${Date.now()}`;
    markCurrent();
  }

  function showPlaceholder() {
    currentFile = null;
    el.preview.hidden = true;
    el.placeholder.hidden = false;
    el.currentTitle.textContent = '—';
  }

  function key(sid, file) { return `${sid}/${file}`; }

  // ---------- iframe からの postMessage ----------

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hview !== true) return;
    const session = currentSession();
    if (!session || !currentFile) return;
    if (d.type === 'scroll') {
      scrollMemory.set(key(session.sessionId, currentFile), d.y);
    }
    if (d.type === 'ready' && pendingRestore) {
      el.preview.contentWindow.postMessage(
        { __hview: true, type: 'restoreScroll', y: pendingRestore },
        '*',
      );
      pendingRestore = null;
    }
  });

  // ---------- 操作 ----------

  el.turns.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-file]');
    if (btn) show(btn.dataset.file);
  });

  el.session.addEventListener('change', () => selectSession(el.session.value));

  el.unread.addEventListener('click', () => {
    if (!state) return;
    // sessions は更新が新しい順。未読のうち一番新しいものへ移る
    const next = state.sessions.find((s) => unread.has(s.sessionId));
    if (next) selectSession(next.sessionId);
  });

  el.modeToggle.addEventListener('change', async () => {
    const r = await post('/api/mode', { enabled: el.modeToggle.checked });
    toast(r.mode.enabled ? 'HTML モードを ON にしました' : 'HTML モードを OFF にしました');
  });

  el.outputMode.addEventListener('change', async () => {
    await post('/api/mode', { outputMode: el.outputMode.value });
    toast(el.outputMode.value === 'single-file' ? '同一ファイル更新モード' : '毎ターン新規モード');
  });

  el.pin.addEventListener('click', () => {
    pinned = !pinned;
    el.pin.setAttribute('aria-pressed', String(pinned));
    el.pin.textContent = pinned ? '📌 固定中' : '📌 ピン留め';
    toast(pinned ? 'この HTML を固定しました。どのセッションの新しいターンでも切り替わりません' : 'ピン留めを解除しました');
  });

  el.download.addEventListener('click', () => {
    const session = currentSession();
    if (!session || !currentFile) return;
    location.href = `/d/${encodeURIComponent(session.sessionId)}/${encodeURIComponent(currentFile)}`;
  });

  el.export.addEventListener('click', async () => {
    const session = currentSession();
    if (!session || !currentFile) return;
    const r = await post('/api/export', { sessionId: session.sessionId, file: currentFile });
    toast(r.ok ? `保存しました: ${r.path}` : `保存に失敗しました: ${r.error}`);
  });

  el.copyPath.addEventListener('click', async () => {
    const session = currentSession();
    if (!session || !currentFile || !state) return;
    const path = `${state.projectRoot}/.claude/hview/${session.sessionId}/${currentFile}`;
    try {
      await navigator.clipboard.writeText(path);
      toast(`パスをコピーしました: ${path}`);
    } catch {
      toast(`コピーできませんでした。手動でどうぞ: ${path}`);
    }
  });

  el.print.addEventListener('click', () => {
    if (!currentFile) return;
    el.preview.contentWindow.postMessage({ __hview: true, type: 'print' }, '*');
  });

  el.reindex.addEventListener('click', async () => {
    const r = await post('/api/reindex', {});
    toast(`${r.found} 件の HTML を読み直しました`);
  });

  // ---------- 小物 ----------

  let toastTimer = null;
  let toastRun = null;

  /** @param {{label:string, run:() => void}} [action] 付けるとクリックできるトーストになる */
  function toast(text, action) {
    el.toastText.textContent = text;
    toastRun = action ? action.run : null;
    el.toastAction.hidden = !action;
    if (action) el.toastAction.textContent = action.label;
    el.toast.classList.add('toast--show');
    el.toast.classList.toggle('toast--action', !!action);
    clearTimeout(toastTimer);
    // 押させたいトーストは少し長く出す
    toastTimer = setTimeout(hideToast, action ? 9000 : 3800);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastRun = null;
    el.toast.classList.remove('toast--show', 'toast--action');
  }

  el.toastAction.addEventListener('click', () => {
    const run = toastRun;
    hideToast();
    if (run) run();
  });

  function readFollow() {
    try { return localStorage.getItem(FOLLOW_KEY) === '1'; } catch { return false; }
  }

  function saveFollow() {
    try { localStorage.setItem(FOLLOW_KEY, follow ? '1' : '0'); } catch { /* 保存できなくても動く */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  fetch('/api/state')
    .then((r) => r.json())
    .then((s) => applyState(s))
    .catch(() => {});
  connect();
})();
