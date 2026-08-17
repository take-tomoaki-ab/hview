import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  isHviewProjectRoot,
  isSafeSegment,
  normalizeProjectRoot,
  parseHviewPath,
  projectId,
  projectLabel,
} from './paths.ts';

let withHview: string;
let withoutHview: string;

beforeAll(() => {
  withHview = mkdtempSync(join(tmpdir(), 'hview-paths-a-'));
  mkdirSync(join(withHview, '.claude', 'hview'), { recursive: true });
  withoutHview = mkdtempSync(join(tmpdir(), 'hview-paths-b-'));
});

afterAll(() => {
  rmSync(withHview, { recursive: true, force: true });
  rmSync(withoutHview, { recursive: true, force: true });
});

describe('normalizeProjectRoot', () => {
  test('絶対パスはそのまま通す', () => {
    expect(normalizeProjectRoot('/Users/foo/bar')).toBe('/Users/foo/bar');
  });

  test('`..` は畳む', () => {
    expect(normalizeProjectRoot('/Users/foo/bar/../baz')).toBe('/Users/foo/baz');
  });

  test('相対パスは受け付けない', () => {
    expect(normalizeProjectRoot('../../etc')).toBeNull();
    expect(normalizeProjectRoot('foo/bar')).toBeNull();
  });

  test('空文字・文字列以外は受け付けない', () => {
    expect(normalizeProjectRoot('')).toBeNull();
    expect(normalizeProjectRoot('   ')).toBeNull();
    expect(normalizeProjectRoot(undefined)).toBeNull();
    expect(normalizeProjectRoot(42)).toBeNull();
    expect(normalizeProjectRoot({ projectRoot: '/tmp' })).toBeNull();
  });

  test('ホームディレクトリそのものは受け付けない（全プロジェクトの混ざり先になる）', () => {
    expect(normalizeProjectRoot(homedir())).toBeNull();
  });
});

describe('isHviewProjectRoot', () => {
  test('.claude/hview があれば true', () => {
    expect(isHviewProjectRoot(withHview)).toBe(true);
  });

  test('.claude/hview が無ければ false', () => {
    expect(isHviewProjectRoot(withoutHview)).toBe(false);
  });

  test('無関係なディレクトリは false', () => {
    expect(isHviewProjectRoot('/etc')).toBe(false);
  });
});

describe('projectId', () => {
  test('同じパスからは同じ ID が出る（再起動しても URL が変わらない）', () => {
    expect(projectId('/a/b')).toBe(projectId('/a/b'));
  });

  test('違うパスからは違う ID が出る', () => {
    expect(projectId('/a/b')).not.toBe(projectId('/a/c'));
  });

  test('URL に載せて安全な形（16 進 12 桁）', () => {
    expect(projectId('/a/b')).toMatch(/^[0-9a-f]{12}$/);
    expect(isSafeSegment(projectId('/a/b'))).toBe(true);
  });
});

describe('projectLabel', () => {
  test('末尾のディレクトリ名を使う', () => {
    expect(projectLabel('/Users/foo/codes/journey-web-event')).toBe('journey-web-event');
  });
});

describe('parseHviewPath', () => {
  const root = '/Users/foo/proj';
  const file = `${root}/.claude/hview/abc-123/turn-001.html`;

  test('対象パスは分解できる', () => {
    expect(parseHviewPath(root, file)).toEqual({ sessionId: 'abc-123', file: 'turn-001.html' });
  });

  test('別プロジェクトのパスは拾わない', () => {
    expect(parseHviewPath('/Users/foo/other', file)).toBeNull();
  });

  test('階層が違うパスは拾わない', () => {
    expect(parseHviewPath(root, `${root}/.claude/hview/turn-001.html`)).toBeNull();
    expect(parseHviewPath(root, `${root}/.claude/hview/a/b/turn-001.html`)).toBeNull();
  });

  test('html 以外は拾わない', () => {
    expect(parseHviewPath(root, `${root}/.claude/hview/abc/index.json`)).toBeNull();
  });
});
