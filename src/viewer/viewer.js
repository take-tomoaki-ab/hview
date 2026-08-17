// hview ビューア。フレームワークは使わない。
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    conn: $('conn'),
    project: $('project'),
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

  /** セッションセレクタの先頭に置く「追従」用の値。ref は `<projectId>/<sessionId>` なので衝突しない。 */
  const FOLLOW = '__follow__';
  const FOLLOW_KEY = 'hview.follow';

  /** @type {{port:number, projectRoot:string, projectId:string, exportDir:string, projects:any[]}|null} */
  let state = null;
  /** 選択中のセッション。プロジェクトをまたぐので projectId と対で持つ。 */
  let sel = null;
  let currentFile = null;
  let pinned = false;
  /** ON の間、新しいターンが届いたセッションへ自動で移る。既定は OFF（読んでいる画面をさらわない） */
  let follow = readFollow();
  /** まだ見ていないターンが届いたセッションの ref。切り替えたら消す。 */
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

  // ---------- セッションの取り回し ----------

  function ref(projectId, sessionId) { return `${projectId}/${sessionId}`; }

  function projects() { return state ? state.projects : []; }

  /** 全プロジェクトのセッションを、更新が新しい順に平らに並べる。 */
  function allSessions() {
    const out = [];
    for (const p of projects()) {
      for (const s of p.sessions) out.push({ ...s, project: p });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function findSession(target) {
    if (!target) return null;
    for (const p of projects()) {
      if (p.projectId !== target.projectId) continue;
      const s = p.sessions.find((x) => x.sessionId === target.sessionId);
      if (s) return { ...s, project: p };
    }
    return null;
  }

  function currentSession() {
    return findSession(sel) || allSessions()[0] || null;
  }

  /** モードの操作対象。セッションが無ければ serve を起動したプロジェクトに向ける。 */
  function currentProject() {
    const s = currentSession();
    if (s) return s.project;
    return projects().find((p) => p.primary) || projects()[0] || null;
  }

  // ---------- 状態の反映 ----------

  function applyState(next, msg) {
    state = next;

    // 未選択のまま、あるいは消えたセッションを指したまま turn を受けると
    // 「見ている当のセッション」を他人扱いしてしまう。判定の前に現実へ合わせておく
    if (!findSession(sel)) {
      const latest = allSessions()[0];
      sel = latest ? { projectId: latest.projectId, sessionId: latest.sessionId } : null;
    }

    // 追従・未読の判定はセレクタを描く前に済ませる。ここで sel が動きうる
    const turn = msg && msg.type === 'turn' ? msg : null;
    if (turn) routeTurn(turn);

    const session = currentSession();
    renderProject();
    renderSessions();
    renderMode();
    renderTurns(session);

    if (!session) { showPlaceholder(); return; }

    // 選択中セッションに新しいターンが来たとき。ピン留め中は切り替えない
    if (turn && turn.projectId === session.projectId && turn.sessionId === session.sessionId) {
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
    const r = ref(msg.projectId, msg.sessionId);
    if (sel && r === ref(sel.projectId, sel.sessionId)) {
      unread.delete(r);
      return;
    }
    if (follow && !pinned) {
      sel = { projectId: msg.projectId, sessionId: msg.sessionId };
      currentFile = null; // 別セッションのファイルなのでスクロール位置は引き継がない
      unread.delete(r);
      return;
    }
    unread.add(r);
    const why = pinned ? '（ピン留め中のため切り替えません）' : '';
    toast(
      `${describe(msg.projectId, msg.sessionId)} に新しいターン「${msg.turn.title}」が届きました${why}`,
      { label: '切り替え', run: () => selectSession(r) },
    );
  }

  /** トーストに出す「どこで起きたか」。プロジェクトが複数あるときだけ名前を添える。 */
  function describe(projectId, sessionId) {
    const p = projects().find((x) => x.projectId === projectId);
    const name = p && projects().length > 1 ? `${p.label} の ` : '';
    return `${name}セッション ${short(sessionId)}`;
  }

  /** 見ているプロジェクトの表示。1 つしか無いときは出さない（今までの見た目のまま）。 */
  function renderProject() {
    const p = currentProject();
    const many = projects().length > 1;
    el.project.hidden = !(many && p);
    if (many && p) {
      el.project.textContent = p.label;
      el.project.title = p.projectRoot;
    }
  }

  function renderMode() {
    const p = currentProject();
    const mode = p ? p.mode : { enabled: false, outputMode: 'per-turn' };
    el.modeToggle.checked = !!mode.enabled;
    el.outputMode.value = mode.outputMode;
    const scope = p && projects().length > 1 ? `${p.label} の ` : '';
    el.modeToggle.title = `${scope}HTML モード`;
  }

  function renderSessions() {
    const list = projects();
    const total = list.reduce((n, p) => n + p.sessions.length, 0);
    if (!total) {
      el.session.innerHTML = '<option>セッションなし</option>';
      renderUnread();
      return;
    }

    const followLabel = `⟳ 最新を自動で追う（${short(sel && sel.sessionId)}）`;
    const options = [
      `<option value="${FOLLOW}"${follow ? ' selected' : ''}>${esc(followLabel)}</option>`,
    ];

    // プロジェクトが複数あるときは optgroup で束ねる。どのプロジェクトのセッションか分からないと選べない
    const many = list.filter((p) => p.sessions.length > 0).length > 1;
    for (const p of list) {
      if (!p.sessions.length) continue;
      const body = p.sessions.map((s) => sessionOption(p, s)).join('');
      options.push(many ? `<optgroup label="${esc(p.label)}">${body}</optgroup>` : body);
    }
    el.session.innerHTML = options.join('');
    renderUnread();
  }

  function sessionOption(p, s) {
    const r = ref(p.projectId, s.sessionId);
    const mark = unread.has(r) ? '● ' : '';
    const label = `${mark}${short(s.sessionId)} (${s.turns.length} ターン)`;
    const selected = !follow && sel && r === ref(sel.projectId, sel.sessionId) ? ' selected' : '';
    return `<option value="${esc(r)}"${selected}>${esc(label)}</option>`;
  }

  /** セレクタは畳まれていると未読が見えないので、隣にバッジも出す。 */
  function renderUnread() {
    const n = allSessions().filter((s) => unread.has(ref(s.projectId, s.sessionId))).length;
    el.unread.hidden = n === 0;
    el.unread.textContent = `● 未読 ${n} セッション`;
  }

  function short(id) { return id ? `${id.slice(0, 8)}…` : '—'; }

  /** セレクタの値（ref か FOLLOW）を選択として適用する。 */
  function selectSession(value) {
    if (!state) return;
    if (value === FOLLOW) {
      follow = true;
      const latest = allSessions()[0];
      if (latest && (!sel || ref(latest.projectId, latest.sessionId) !== ref(sel.projectId, sel.sessionId))) {
        sel = { projectId: latest.projectId, sessionId: latest.sessionId };
        currentFile = null;
      }
      unread.clear();
      toast('新しいターンが届いたセッションへ自動で切り替えます');
    } else {
      follow = false;
      const [projectId, sessionId] = splitRef(value);
      if (!sel || projectId !== sel.projectId || sessionId !== sel.sessionId) {
        sel = { projectId, sessionId };
        currentFile = null;
      }
      unread.delete(value);
    }
    saveFollow();
    applyState(state);
  }

  function splitRef(value) {
    const i = String(value).indexOf('/');
    return i < 0 ? [value, ''] : [value.slice(0, i), value.slice(i + 1)];
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
    pendingRestore = keepScroll ? scrollMemory.get(key(session, file)) || 0 : 0;
    currentFile = file;
    el.preview.hidden = false;
    el.placeholder.hidden = true;
    // 同じ URL でも確実に読み直させたいのでキャッシュバスターを付ける
    el.preview.src = `${filePath('/f/', session, file)}?t=${Date.now()}`;
    markCurrent();
  }

  function filePath(prefix, session, file) {
    return (
      prefix +
      encodeURIComponent(session.projectId) +
      '/' +
      encodeURIComponent(session.sessionId) +
      '/' +
      encodeURIComponent(file)
    );
  }

  function showPlaceholder() {
    currentFile = null;
    el.preview.hidden = true;
    el.placeholder.hidden = false;
    el.currentTitle.textContent = '—';
  }

  function key(session, file) { return `${session.projectId}/${session.sessionId}/${file}`; }

  // ---------- iframe からの postMessage ----------

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hview !== true) return;
    const session = currentSession();
    if (!session || !currentFile) return;
    if (d.type === 'scroll') {
      scrollMemory.set(key(session, currentFile), d.y);
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
    // 更新が新しい順に見て、未読のうち一番新しいものへ移る
    const next = allSessions().find((s) => unread.has(ref(s.projectId, s.sessionId)));
    if (next) selectSession(ref(next.projectId, next.sessionId));
  });

  el.modeToggle.addEventListener('change', async () => {
    const p = currentProject();
    if (!p) return;
    const r = await post('/api/mode', { projectId: p.projectId, enabled: el.modeToggle.checked });
    const scope = projects().length > 1 ? `${p.label} の ` : '';
    toast(r.mode.enabled ? `${scope}HTML モードを ON にしました` : `${scope}HTML モードを OFF にしました`);
  });

  el.outputMode.addEventListener('change', async () => {
    const p = currentProject();
    if (!p) return;
    await post('/api/mode', { projectId: p.projectId, outputMode: el.outputMode.value });
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
    location.href = filePath('/d/', session, currentFile);
  });

  el.export.addEventListener('click', async () => {
    const session = currentSession();
    if (!session || !currentFile) return;
    const r = await post('/api/export', {
      projectId: session.projectId,
      sessionId: session.sessionId,
      file: currentFile,
    });
    toast(r.ok ? `保存しました: ${r.path}` : `保存に失敗しました: ${r.error}`);
  });

  el.copyPath.addEventListener('click', async () => {
    const session = currentSession();
    if (!session || !currentFile) return;
    const path = `${session.project.projectRoot}/.claude/hview/${session.sessionId}/${currentFile}`;
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
