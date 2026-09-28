/**
 * プレビュー用 HTML に注入する橋渡しスクリプト。
 *
 * iframe は `sandbox="allow-scripts"` かつ `allow-same-origin` なしで隔離するため、
 * 親からは iframe の中の DOM もスクロール位置も読めない。
 * 「更新してもスクロール位置を維持する」を成立させる手段が postMessage しかないので、
 * サーバ側で配信時にこの一片だけを差し込む。ユーザーが書いた HTML 本体には手を入れない。
 *
 * コメント用のインスペクターも同じ理由でここに同居させる。親は iframe の DOM を触れないので、
 * 要素のハイライトと特定はこの中で行い、選んだ要素の手がかりだけを postMessage で渡す。
 * 保存（fetch）は親が行う。iframe の `connect-src 'none'` は緩めない。
 */
export const BRIDGE_SCRIPT = `
<script data-hview-bridge>
(() => {
  const send = (msg) => { try { parent.postMessage(Object.assign({ __hview: true }, msg), '*'); } catch (e) {} };

  let ticking = false;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      send({ type: 'scroll', y: Math.round(scrollY) });
    });
  }, { passive: true });

  // ---------- インスペクター ----------

  let inspecting = false;
  /** マウスの真下にある要素。↑ キーで広げる前の起点 */
  let baseEl = null;
  /** ハイライト中の要素。baseEl か、その祖先 */
  let hoverEl = null;
  let selectedEl = null;
  /** 選んだときの起点。選んだあとにマウスが動いても、↓ で戻る先を変えないため */
  let selectedBase = null;
  /** 未反映コメントの付いた要素。{ n, selector } */
  let markers = [];
  let ui = null;

  const COLORS = { hover: '#2f6feb', selected: '#c2410c' };

  /**
   * 描画用の層。shadow DOM に閉じて HTML 側の CSS から守る。
   * body ではなく html 直下に置くのは、body 直下の :nth-of-type の数え方を変えないため。
   */
  function ensureUi() {
    if (ui) return ui;
    const host = document.createElement('hview-layer');
    const root = host.attachShadow({ mode: 'open' });
    const font = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
    root.innerHTML =
      '<style>' +
      '.box{position:fixed;pointer-events:none;z-index:2147483646;border:2px solid;border-radius:3px;display:none;box-sizing:border-box}' +
      '.hover{border-color:' + COLORS.hover + ';background:rgba(47,111,235,.12)}' +
      '.sel{border-color:' + COLORS.selected + ';background:rgba(194,65,12,.12)}' +
      '.label{position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.5 ' + font + ';background:' + COLORS.hover + ';color:#fff;padding:1px 6px;border-radius:3px;display:none;white-space:nowrap}' +
      '.outline{position:fixed;pointer-events:none;z-index:2147483644;border:1.5px dashed ' + COLORS.selected + ';border-radius:3px;box-sizing:border-box}' +
      '.pin{position:fixed;pointer-events:none;z-index:2147483645;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:' + COLORS.selected + ';color:#fff;font:700 11px/18px ' + font + ';text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.35);box-sizing:border-box}' +
      '</style>' +
      '<div class="marks"></div><div class="box sel"></div><div class="box hover"></div><div class="label"></div>';
    document.documentElement.appendChild(host);
    ui = {
      host,
      marks: root.querySelector('.marks'),
      sel: root.querySelector('.sel'),
      hover: root.querySelector('.hover'),
      label: root.querySelector('.label'),
    };
    return ui;
  }

  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return null; }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(r.width, 2) + 'px';
    box.style.height = Math.max(r.height, 2) + 'px';
    return r;
  }

  function nameOf(el) {
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return s;
  }

  function draw() {
    if (!ui) return;
    if (!inspecting) {
      ui.hover.style.display = 'none';
      ui.label.style.display = 'none';
      ui.sel.style.display = 'none';
      ui.marks.innerHTML = '';
      return;
    }
    const r = place(ui.hover, hoverEl);
    if (r) {
      ui.label.style.display = 'block';
      ui.label.textContent = nameOf(hoverEl) + '  ' + Math.round(r.width) + '×' + Math.round(r.height) + '   ↑ 親へ / ↓ 戻る';
      ui.label.style.left = Math.max(r.left, 0) + 'px';
      ui.label.style.top = (r.top >= 22 ? r.top - 22 : r.bottom + 4) + 'px';
    } else {
      ui.label.style.display = 'none';
    }
    place(ui.sel, selectedEl);
    drawMarkers();
  }

  function drawMarkers() {
    const frag = document.createDocumentFragment();
    for (const m of markers) {
      let el = null;
      try { el = document.querySelector(m.selector); } catch (e) { el = null; }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const outline = document.createElement('div');
      outline.className = 'outline';
      outline.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
      const pin = document.createElement('div');
      pin.className = 'pin';
      pin.textContent = String(m.n);
      pin.style.left = Math.max(r.left - 9, 0) + 'px';
      pin.style.top = Math.max(r.top - 9, 0) + 'px';
      frag.append(outline, pin);
    }
    ui.marks.replaceChildren(frag);
  }

  let drawQueued = false;
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function isPickable(el) {
    return el && el.nodeType === 1 && el !== document.documentElement && (!ui || el !== ui.host);
  }

  /** id が一意ならそこで打ち切り、それ以外は localName と :nth-of-type で body まで辿る。 */
  function selectorOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) {
        const id = '#' + CSS.escape(n.id);
        if (document.querySelectorAll(id).length === 1) { parts.unshift(id); break; }
      }
      let part = n.localName;
      const p = n.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.localName === n.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  /** 文書順で el より前にある最後の見出し。 */
  function headingOf(el) {
    let found = '';
    for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
      if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        found = h.textContent;
      } else {
        break;
      }
    }
    return squash(found).slice(0, 120);
  }

  function squash(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }

  function describe(el) {
    return {
      selector: selectorOf(el),
      tag: el.localName,
      text: squash(el.textContent).slice(0, 160),
      html: el.outerHTML.slice(0, 400),
      heading: headingOf(el),
    };
  }

  function pick(el, keepBase) {
    if (!isPickable(el)) return;
    // ↑ で広げてから選んだときも、↓ で元の要素まで戻れるように起点はマウスの真下の要素にする
    if (!keepBase) selectedBase = baseEl && el.contains(baseEl) ? baseEl : el;
    selectedEl = el;
    queueDraw();
    send({ type: 'pick', target: describe(el) });
  }

  addEventListener('mousemove', (e) => {
    if (!inspecting) return;
    const t = e.target;
    if (t === baseEl || !isPickable(t)) return;
    baseEl = t;
    hoverEl = t;
    queueDraw();
  }, true);

  // クリックはページ側に渡さない。リンク遷移や details の開閉を起こさないため
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick']) {
    addEventListener(type, (e) => {
      if (!inspecting) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'click') pick(hoverEl || e.target);
    }, true);
  }

  /**
   * ↑ で親へ広げ、↓ で起点側へ戻す。repick なら広げた要素をそのまま選び直す。
   * 選んだあとはフォーカスが親の入力欄にあるので、親から転送されたキーもここで処理する。
   */
  function handleKey(key, repick) {
    const base = repick ? selectedEl : hoverEl;
    const origin = repick ? selectedBase : baseEl;
    if (!base) return false;
    let next = null;
    if (key === 'ArrowUp') {
      const p = base.parentElement;
      if (isPickable(p)) next = p;
    } else if (key === 'ArrowDown') {
      if (origin && base !== origin && base.contains(origin)) {
        let n = origin;
        while (n.parentElement && n.parentElement !== base) n = n.parentElement;
        next = n;
      }
    } else if (key === 'Enter' && !repick) {
      pick(base);
      return true;
    } else {
      return false;
    }
    if (next) {
      hoverEl = next;
      if (repick) pick(next, true);
      else queueDraw();
    }
    return true;
  }

  addEventListener('keydown', (e) => {
    if (!inspecting) return;
    if (e.key === 'Escape') send({ type: 'inspectExit' });
    else if (!handleKey(e.key, false)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  addEventListener('scroll', queueDraw, { passive: true, capture: true });
  addEventListener('resize', queueDraw);

  function setInspect(on) {
    inspecting = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (on) ensureUi();
    else { baseEl = null; hoverEl = null; selectedEl = null; selectedBase = null; }
    queueDraw();
  }

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hview !== true) return;
    if (d.type === 'restoreScroll' && typeof d.y === 'number') {
      scrollTo(0, d.y);
    }
    if (d.type === 'print') {
      print();
    }
    if (d.type === 'inspect') {
      if (Array.isArray(d.markers)) markers = d.markers;
      if (typeof d.on === 'boolean' && d.on !== inspecting) setInspect(d.on);
      else queueDraw();
    }
    if (d.type === 'key' && inspecting) {
      handleKey(d.key, !!d.repick);
    }
    if (d.type === 'clearSelection') {
      selectedEl = null;
      queueDraw();
    }
  });

  const ready = () => send({
    type: 'ready',
    title: document.title || '',
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
  });
  if (document.readyState === 'complete') ready();
  else addEventListener('load', ready);
})();
</script>
`;

/** `</body>` の直前に差し込む。見つからなければ末尾に足す。 */
export function injectBridge(html: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + BRIDGE_SCRIPT;
  return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
}

/**
 * プレビューに付ける CSP。
 * - `connect-src 'none'` で fetch/XHR/WebSocket を止める
 * - `img-src`/`font-src` を data: に限って外部読み込みを止める
 * - 図の中のインラインスクリプトは動かしたいので `script-src 'unsafe-inline'`。
 *   iframe は opaque origin なので、動いても親や他オリジンには手が届かない。
 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');
