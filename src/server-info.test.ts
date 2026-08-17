import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_PORT } from './paths.ts';
import {
  clearServerInfo,
  isPidAlive,
  liveServers,
  readServerRegistry,
  resolvePort,
  upsertServerEntry,
  writeServerInfo,
} from './server-info.ts';

/** 存在しないプロセス。macOS の pid 上限（99998）より大きい値を使う。 */
const DEAD_PID = 99999999;

let stateDir: string;
let projectA: string;
let projectB: string;
let projectC: string;
let prevStateDir: string | undefined;

function makeProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.claude', 'hview'), { recursive: true });
  return root;
}

beforeAll(() => {
  prevStateDir = process.env.HVIEW_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), 'hview-state-'));
  process.env.HVIEW_STATE_DIR = stateDir;
  projectA = makeProject('hview-srv-a-');
  projectB = makeProject('hview-srv-b-');
  projectC = makeProject('hview-srv-c-');
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.HVIEW_STATE_DIR;
  else process.env.HVIEW_STATE_DIR = prevStateDir;
  for (const d of [stateDir, projectA, projectB, projectC]) {
    rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  rmSync(join(stateDir, 'servers.json'), { force: true });
  clearServerInfo(projectA);
  clearServerInfo(projectB);
});

describe('isPidAlive', () => {
  test('自分自身は生きている', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('存在しない pid は false', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  test('pid として不正な値は false', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

describe('共通レジストリ', () => {
  test('serve すると server.json とレジストリの両方に載る', () => {
    writeServerInfo(projectA, { port: 5757, pid: process.pid, startedAt: '2026-08-17T00:00:00.000Z' });
    expect(readServerRegistry()).toEqual([
      { port: 5757, pid: process.pid, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' },
    ]);
  });

  test('止めるとレジストリから消える', () => {
    writeServerInfo(projectA, { port: 5757, pid: process.pid, startedAt: '2026-08-17T00:00:00.000Z' });
    clearServerInfo(projectA);
    expect(readServerRegistry()).toEqual([]);
  });

  test('死んだプロセスの記録は生存一覧に出ない', () => {
    upsertServerEntry({ port: 5900, pid: DEAD_PID, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' });
    expect(readServerRegistry()).toHaveLength(1);
    expect(liveServers()).toEqual([]);
  });

  test('同じプロジェクトの記録は 1 件に保たれる', () => {
    upsertServerEntry({ port: 5757, pid: process.pid, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' });
    upsertServerEntry({ port: 5801, pid: process.pid, projectRoot: projectA, startedAt: '2026-08-17T01:00:00.000Z' });
    expect(readServerRegistry()).toHaveLength(1);
    expect(readServerRegistry()[0]?.port).toBe(5801);
  });
});

describe('resolvePort', () => {
  test('自分のプロジェクトで serve していればそのポート', () => {
    writeServerInfo(projectA, { port: 5801, pid: process.pid, startedAt: '2026-08-17T00:00:00.000Z' });
    expect(resolvePort(projectA)).toBe(5801);
  });

  // これがチケットの「ポート解決も外れうる」への対応。
  // 通知元プロジェクトには server.json が無いので、既定値へのフォールバックだけだと
  // 別ポートで起動しているサーバに届かず、完全な無音になる
  test('server.json が無いプロジェクトからでも、起動中サーバのポートを引ける', () => {
    writeServerInfo(projectA, { port: 5801, pid: process.pid, startedAt: '2026-08-17T00:00:00.000Z' });
    expect(resolvePort(projectB)).toBe(5801);
  });

  test('複数動いていれば起動が新しいものを選ぶ', () => {
    upsertServerEntry({ port: 5801, pid: process.pid, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' });
    upsertServerEntry({ port: 5802, pid: process.pid, projectRoot: projectB, startedAt: '2026-08-17T09:00:00.000Z' });
    expect(resolvePort(projectC)).toBe(5802);
  });

  test('自分のプロジェクトの記録があればそちらを優先する', () => {
    upsertServerEntry({ port: 5801, pid: process.pid, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' });
    upsertServerEntry({ port: 5802, pid: process.pid, projectRoot: projectB, startedAt: '2026-08-17T09:00:00.000Z' });
    expect(resolvePort(projectA)).toBe(5801);
  });

  test('死んだサーバの記録しか無ければ既定値に戻る', () => {
    upsertServerEntry({ port: 5900, pid: DEAD_PID, projectRoot: projectA, startedAt: '2026-08-17T00:00:00.000Z' });
    expect(resolvePort(projectB)).toBe(DEFAULT_PORT);
  });

  test('何も動いていなければ既定値', () => {
    expect(resolvePort(projectB)).toBe(DEFAULT_PORT);
  });
});
