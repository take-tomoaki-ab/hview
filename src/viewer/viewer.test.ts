import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * viewer.js はブラウザ用の IIFE なので import できない。
 * ソースを読んで最小限の DOM スタブの中で走らせ、実際に描かれた `<option>` を見る。
 */
const SRC = readFileSync(join(import.meta.dir, 'viewer.js'), 'utf8');

/** スタブなので緩い型で足りる。 */
type Fake = Record<string, any>;

function fakeNode(): Fake {
  const n: Fake = {
    innerHTML: '',
    textContent: '',
    hidden: false,
    className: '',
    title: '',
    value: '',
    checked: false,
    src: '',
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    querySelectorAll: () => [],
    // 登録されたハンドラは `__on.<type>()` で叩けるようにしておく
    __on: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) {
      n.__on[type] = fn;
    },
  };
  return n;
}

type Turn = { n: number; file: string; title: string };

function session(sessionId: string, turns: Turn[], projectId = 'p1') {
  return {
    sessionId,
    projectId,
    updatedAt: '2026-08-17T00:00:00.000Z',
    turns: turns.map((t) => ({ ...t, createdAt: '', updatedAt: '2026-08-17T00:00:00.000Z' })),
  };
}

function project(projectId: string, label: string, sessions: unknown[], primary = true) {
  return {
    projectId,
    projectRoot: `/tmp/${label}`,
    label,
    primary,
    mode: { enabled: false, outputMode: 'per-turn', updatedAt: '' },
    sessions,
  };
}

/** viewer.js を走らせ、`/api/state` の応答を食わせたあとの DOM ノードを返す。 */
async function boot(projects: unknown[], opts: { follow?: boolean } = {}): Promise<Map<string, Fake>> {
  const nodes = new Map<string, Fake>();
  const document = {
    getElementById(id: string) {
      const found = nodes.get(id) ?? fakeNode();
      nodes.set(id, found);
      return found;
    },
  };
  const state = {
    port: 5757,
    projectRoot: '/tmp/proj',
    projectId: 'p1',
    mode: { enabled: false, outputMode: 'per-turn', updatedAt: '' },
    exportDir: '/tmp/out',
    projects,
  };
  const localStorage = { getItem: () => (opts.follow ? '1' : '0'), setItem() {} };
  const fetchStub = async () => ({ json: async () => state });
  class FakeWebSocket {
    addEventListener() {}
    close() {}
  }

  const run = new Function(
    'document',
    'WebSocket',
    'location',
    'fetch',
    'localStorage',
    'navigator',
    'addEventListener',
    SRC,
  );
  run(
    document,
    FakeWebSocket,
    { host: '127.0.0.1:5757' },
    fetchStub,
    localStorage,
    { clipboard: { writeText: async () => {} } },
    () => {},
  );

  // fetch → json → applyState を待つ
  await new Promise((r) => setTimeout(r, 0));
  return nodes;
}

const selectHtml = (nodes: Map<string, Fake>) => String(nodes.get('session')?.innerHTML ?? '');

describe('セッションセレクタのラベル', () => {
  test('最新ターンの HTML タイトルを出す', async () => {
    const nodes = await boot([
      project('p1', 'proj', [
        session('e38a32c3-1111-2222-3333-444455556666', [
          { n: 1, file: 'turn-001.html', title: '前のターン' },
          { n: 2, file: 'turn-002.html', title: 'ビューアのセッション表示改善' },
        ]),
      ]),
    ]);
    const html = selectHtml(nodes);
    expect(html).toContain('>ビューアのセッション表示改善 (2 ターン)<');
    expect(html).not.toContain('前のターン (2 ターン)');
  });

  test('完全な sessionId はホバー（title 属性）に残す', async () => {
    const nodes = await boot([
      project('p1', 'proj', [
        session('e38a32c3-1111-2222-3333-444455556666', [
          { n: 1, file: 'turn-001.html', title: 'Datadog エラーの原因調査' },
        ]),
      ]),
    ]);
    expect(selectHtml(nodes)).toContain(
      'title="Datadog エラーの原因調査\ne38a32c3-1111-2222-3333-444455556666"',
    );
  });

  test('長いタイトルは省略する', async () => {
    const long = 'あ'.repeat(40);
    const nodes = await boot([
      project('p1', 'proj', [session('aaaaaaaa-bbbb', [{ n: 1, file: 'turn-001.html', title: long }])]),
    ]);
    const html = selectHtml(nodes);
    expect(html).toContain(`>${'あ'.repeat(23)}… (1 ターン)<`);
    // ホバーには省略前のタイトルが残る
    expect(html).toContain(`title="${long}\naaaaaaaa-bbbb"`);
  });

  test('タイトルが取れないセッションは短縮 sessionId にフォールバックする', async () => {
    const nodes = await boot([
      project('p1', 'proj', [
        // <title> なしの HTML はファイル名が title に入る（state.ts の recordTurn）
        session('4aa50c0b-9999', [{ n: 1, file: 'turn-001.html', title: 'turn-001.html' }]),
      ]),
    ]);
    const html = selectHtml(nodes);
    expect(html).toContain('>4aa50c0b… (1 ターン)<');
    expect(html).toContain('title="4aa50c0b-9999"');
  });

  test('「最新を自動で追う」もタイトルで出す', async () => {
    const nodes = await boot(
      [
        project('p1', 'proj', [
          session('e38a32c3-1111', [{ n: 1, file: 'turn-001.html', title: '追っている話題' }]),
          session('4aa50c0b-9999', [{ n: 1, file: 'turn-001.html', title: '別の話題' }]),
        ]),
      ],
      { follow: true },
    );
    const html = selectHtml(nodes);
    expect(html).toContain('>⟳ 最新を自動で追う（追っている話題）<');
    expect(html).toContain('<option value="__follow__" title="追っている話題\ne38a32c3-1111" selected>');
  });

  test('「最新を自動で追う」のタイトルは前置きの分だけ短く詰める', async () => {
    const nodes = await boot([
      project('p1', 'proj', [
        session('e38a32c3-1111', [{ n: 1, file: 'turn-001.html', title: 'あ'.repeat(20) }]),
      ]),
    ]);
    const html = selectHtml(nodes);
    // 前置き「⟳ 最新を自動で追う（）」＋ 12 文字までなので、セレクタの幅からはみ出さない
    expect(html).toContain(`>⟳ 最新を自動で追う（${'あ'.repeat(11)}…）<`);
    // 個別の option 側は 24 文字まで
    expect(html).toContain(`>${'あ'.repeat(20)} (1 ターン)<`);
  });

  test('「最新を自動で追う」は選択中ではなく最新セッションのタイトルを出す', async () => {
    const nodes = await boot([
      project('p1', 'proj', [
        session('e38a32c3-1111', [{ n: 1, file: 'turn-001.html', title: '最新のセッション' }]),
        session('4aa50c0b-9999', [{ n: 1, file: 'turn-001.html', title: '古いセッション' }]),
      ]),
    ]);
    // 追従 OFF の初期状態では先頭セッションが選択されるので、選択を 2 番目へ動かす
    nodes.get('session')!.value = 'p1/4aa50c0b-9999';
    nodes.get('session')!.__on.change();
    const html = selectHtml(nodes);
    expect(html).toContain('>⟳ 最新を自動で追う（最新のセッション）<');
    expect(html).toContain(
      '<option value="p1/4aa50c0b-9999" title="古いセッション\n4aa50c0b-9999" selected>',
    );
  });

  test('プロジェクトが複数あっても各 option はタイトル表示になる', async () => {
    const nodes = await boot([
      project('p1', 'proj-a', [
        session('e38a32c3-1111', [{ n: 1, file: 'turn-001.html', title: 'A のターン' }], 'p1'),
      ]),
      project('p2', 'proj-b', [
        session('4aa50c0b-9999', [{ n: 1, file: 'turn-001.html', title: 'B のターン' }], 'p2'),
      ], false),
    ]);
    const html = selectHtml(nodes);
    expect(html).toContain('<optgroup label="proj-a">');
    expect(html).toContain('<optgroup label="proj-b">');
    expect(html).toContain('<option value="p1/e38a32c3-1111" title="A のターン\ne38a32c3-1111" selected>A のターン (1 ターン)</option>');
    expect(html).toContain('<option value="p2/4aa50c0b-9999" title="B のターン\n4aa50c0b-9999">B のターン (1 ターン)</option>');
  });

  test('セッションが無いときは今までどおり', async () => {
    const nodes = await boot([project('p1', 'proj', [])]);
    expect(selectHtml(nodes)).toBe('<option>セッションなし</option>');
  });
});
