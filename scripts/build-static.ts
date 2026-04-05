/**
 * 静的アセット生成スクリプト
 * app.js.ts / style.css.ts のテンプレートリテラルを評価し
 * public/app.js と public/style.css として書き出す。
 *
 * 使い方: npx tsx scripts/build-static.ts
 */
import { JS } from '../src/app.js.ts';
import { CSS } from '../src/style.css.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = process.cwd();
const publicDir = join(__dir, 'public');
mkdirSync(publicDir, { recursive: true });

writeFileSync(join(publicDir, 'app.js'), JS, 'utf8');
writeFileSync(join(publicDir, 'style.css'), CSS, 'utf8');

console.log(`✅ public/app.js   — ${JS.length.toLocaleString()} chars`);
console.log(`✅ public/style.css — ${CSS.length.toLocaleString()} chars`);
