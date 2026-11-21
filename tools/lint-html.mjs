// HTML の中の <script> を ESLint で調べる（npm run lint から呼ぶ）。
//
// 管理画面は、Admin.html が AdminCore・AdminViews などの部品を順に読み込んで、1つの画面になる（GAS の .gs と同じく、名前を共有する）。
// そこで、ほかの部品で定義した名前を、そのファイルから見える名前として登録する。
//   - どこにも定義のない名前を使っている → no-undef
//   - 同じ名前を2つの部品で定義している → no-redeclare
// お客様ページ（Portal.html）は1ファイルで完結しているので、単独で調べる。
import { readFileSync, readdirSync } from 'node:fs';
import { ESLint } from 'eslint';
import globals from 'globals';

const scriptsOf = (file) => {
  const html = readFileSync(file, 'utf8');
  const out = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    // 行番号がファイルと合うように、<script> の前の行数だけ空行を足す
    const before = html.slice(0, m.index + '<script>'.length).split('\n').length - 1;
    out.push('\n'.repeat(before) + m[1]);
  }
  return out;
};
const declared = (code) => {
  const names = new Set();
  for (const m of code.matchAll(/^(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // var a = 1, b = 2; の2つめ以降（1行に並べて書いているもの）
  for (const m of code.matchAll(/^var\s+([^;]*);/gm)) {
    for (const part of m[1].split(/,(?![^({[]*[)}\]])/)) { const n = /^\s*([A-Za-z_$][\w$]*)\s*(=|$)/.exec(part); if (n) names.add(n[1]); }
  }
  return names;
};

const rules = {
  'no-undef': 'error',
  'no-redeclare': ['error', { builtinGlobals: true }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-self-assign': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-cond-assign': ['error', 'except-parens']
};
const base = { ...globals.browser, google: 'readonly' };   // google.script.run

// 管理画面の部品（Admin.html の中の小さい <script> も含める）
const adminFiles = ['Admin.html', ...readdirSync('.').filter((f) => /^Admin\w+\.html$/.test(f) && f !== 'AdminCss.html').sort()];
const units = [];
for (const f of adminFiles) scriptsOf(f).forEach((code, i) => units.push({ file: f, code, group: 'admin', key: f + '#' + i }));
for (const f of ['Portal.html']) scriptsOf(f).forEach((code, i) => units.push({ file: f, code, group: f, key: f + '#' + i }));

let problems = 0;
// ファイルごとに、見える名前（globals）が違うので、ESLint をそのつど作る
for (const u of units) {
  const g = { ...base };
  for (const other of units) {
    if (other.group !== u.group || other.key === u.key) continue;
    for (const n of declared(other.code)) g[n] = 'readonly';
  }
  const one = new ESLint({ overrideConfigFile: true, overrideConfig: { languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: g }, rules } });
  const [res] = await one.lintText(u.code, { filePath: u.file + '.js' });
  for (const m of res.messages) {
    problems++;
    console.log(u.file + ':' + m.line + ':' + m.column + '  ' + m.message + '  (' + (m.ruleId || '') + ')');
  }
}
if (problems) { console.log('\n✖ ' + problems + ' problems in HTML scripts'); process.exit(1); }
console.log('HTML の中のスクリプト：問題なし（' + units.length + ' 個）');
