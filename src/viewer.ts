import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, 'viewer');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

export const VIEWER_HTML = read('index.html');
export const VIEWER_CSS = read('viewer.css');
export const VIEWER_JS = read('viewer.js');
