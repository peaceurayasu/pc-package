// ESLint の設定（Google Apps Script 用）
//
// GAS は、全部の .gs ファイルが1つの場所（グローバル）を共有する。
// そこで、ほかの .gs で定義した関数・定数を、そのファイルから見える名前として登録する。
//   - どこにも定義のない名前を使っている → no-undef で見つかる（書きまちがい・消し忘れ）
//   - 同じ名前を2つのファイルで定義している → no-redeclare で見つかる（GAS では後のほうが勝ってしまう）
// HTML の中の <script> は対象外。
import { readdirSync, readFileSync } from 'node:fs';

// GAS が用意しているもの
const GAS_GLOBALS = [
  'SpreadsheetApp', 'CacheService', 'PropertiesService', 'LockService', 'Utilities', 'Session',
  'HtmlService', 'ContentService', 'DriveApp', 'MailApp', 'ScriptApp', 'UrlFetchApp', 'CalendarApp',
  'GmailApp', 'DocumentApp', 'Logger', 'console'
];

const files = readdirSync('.').filter((f) => f.endsWith('.gs')).sort();

// 行の頭にある function / const / let / var を、そのファイルで定義した名前として拾う。
// var は、何度書いても同じものを指す（FILE_VERSIONS_ のように、わざと各ファイルで書いているもの）ので、別に覚えておく
const declared = {};
const varsOf = {};
for (const f of files) {
  const names = new Set(), vars = new Set();
  for (const m of readFileSync(f, 'utf8').matchAll(/^(function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[2]);
    if (m[1].startsWith('var')) vars.add(m[2]);
  }
  declared[f] = names;
  varsOf[f] = vars;
}

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
  'no-cond-assign': 'error',
  'no-unused-vars': 'off' // 画面や GAS から呼ぶ関数は、ほかのファイルからは使われないので
};

export default [
  { ignores: ['node_modules/**'] },
  ...files.map((f) => {
    const globals = {};
    for (const g of GAS_GLOBALS) globals[g] = 'readonly';
    for (const other of files) {
      if (other === f) continue;
      for (const n of declared[other]) if (!varsOf[f].has(n) || !varsOf[other].has(n)) globals[n] = 'readonly';
    }
    return { files: [f], languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals }, rules };
  })
];
