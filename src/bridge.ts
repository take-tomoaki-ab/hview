/**
 * プレビュー用 HTML に注入する橋渡しスクリプト。
 *
 * iframe は `sandbox="allow-scripts"` かつ `allow-same-origin` なしで隔離するため、
 * 親からは iframe の中の DOM もスクロール位置も読めない。
 * 「更新してもスクロール位置を維持する」を成立させる手段が postMessage しかないので、
 * サーバ側で配信時にこの一片だけを差し込む。ユーザーが書いた HTML 本体には手を入れない。
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

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hview !== true) return;
    if (d.type === 'restoreScroll' && typeof d.y === 'number') {
      scrollTo(0, d.y);
    }
    if (d.type === 'print') {
      print();
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
