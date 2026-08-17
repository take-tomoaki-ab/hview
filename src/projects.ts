import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isHviewProjectRoot, normalizeProjectRoot, projectsFile, userHviewRoot } from './paths.ts';

const MAX_REMEMBERED = 50;

/**
 * ビューアが扱ったプロジェクトの一覧。
 * サーバは 1 プロジェクトで起動するが、hook はどのプロジェクトからでも通知してくる。
 * ここに覚えておくことで、サーバを再起動しても他プロジェクトのターンを見失わない。
 */
export function readKnownProjects(): string[] {
  try {
    const raw = JSON.parse(readFileSync(projectsFile(), 'utf8')) as { projects?: unknown };
    if (!Array.isArray(raw.projects)) return [];
    const out: string[] = [];
    for (const p of raw.projects) {
      const root = normalizeProjectRoot(p);
      if (root && isHviewProjectRoot(root) && !out.includes(root)) out.push(root);
    }
    return out;
  } catch {
    return [];
  }
}

/** 既に覚えていれば何もしない。書き込みは一時ファイル → rename で途中の状態を読ませない。 */
export function rememberProject(projectRoot: string): void {
  const known = readKnownProjects();
  if (known.includes(projectRoot)) return;
  const next = [projectRoot, ...known].slice(0, MAX_REMEMBERED);
  try {
    mkdirSync(userHviewRoot(), { recursive: true });
    const dest = projectsFile();
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ projects: next }, null, 2)}\n`);
    renameSync(tmp, dest);
  } catch {
    // 覚えられなくても、そのサーバが動いている間の表示には影響しない
  }
}
