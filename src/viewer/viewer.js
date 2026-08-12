// hview ビューア。フレームワークは使わない。
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    conn: $('conn'),
    session: $('session'),
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
  };

  /** @type {{projectRoot:string, mode:any, sessions:any[], exportDir:string}|null} */
  let state = null;
  let sessionId = null;
  let currentFile = null;
  let pinned = false;
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

    renderSessions();
    const session = currentSession();
    renderTurns(session);

    if (!session) { showPlaceholder(); return; }

    // 新しいターンが来たとき。ピン留め中は切り替えない
    if (msg && msg.type === 'turn' && msg.sessionId === session.sessionId) {
      if (pinned && currentFile && currentFile !== msg.turn.file) {
        toast(`新しいターン「${msg.turn.title}」が届きました（ピン留め中のため切り替えません）`);
      } else {
        show(msg.turn.file, { keepScroll: msg.turn.file === currentFile });
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

  function currentSession() {
    if (!state || !state.sessions.length) return null;
    return state.sessions.find((s) => s.sessionId === sessionId) || state.sessions[0];
  }

  function renderSessions() {
    const sessions = state.sessions;
    if (!sessions.length) {
      el.session.innerHTML = '<option>セッションなし</option>';
      return;
    }
    if (!sessionId || !sessions.some((s) => s.sessionId === sessionId)) {
      sessionId = sessions[0].sessionId;
    }
    el.session.innerHTML = sessions
      .map((s) => {
        const n = s.turns.length;
        const label = `${s.sessionId.slice(0, 8)}… (${n} ターン)`;
        return `<option value="${esc(s.sessionId)}"${s.sessionId === sessionId ? ' selected' : ''}>${esc(label)}</option>`;
      })
      .join('');
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

  el.session.addEventListener('change', () => {
    sessionId = el.session.value;
    currentFile = null;
    applyState(state);
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
    toast(pinned ? 'この HTML を固定しました。新しいターンでも切り替わりません' : 'ピン留めを解除しました');
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
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('toast--show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('toast--show'), 3800);
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
