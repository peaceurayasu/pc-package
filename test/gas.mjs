// テスト用：.gs を全部読み込んで、関数を呼べるようにする。
// Google のサービス（Utilities など）は、テストで使うぶんだけ代わりを用意する。
// スプレッドシート・ドライブを使う関数はテストしない（ここには無いので、呼ぶとエラーになる）。
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Asia/Tokyo';

/** GAS のバイト列は符号付き（-128〜127） */
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (arr) => Buffer.from(arr.map((b) => (b < 0 ? b + 256 : b)));

/** Utilities.formatDate の代わり（このアプリが使う書式だけ） */
function formatDate(date, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace(/^H$/, String(Number(parts.hour)));
}

export function loadGas() {
  const props = new Map();
  const context = {
    console,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, value) => signed(createHash(alg).update(typeof value === 'string' ? Buffer.from(value, 'utf8') : unsigned(value)).digest()),
      getUuid: () => randomUUID(),
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      base64Encode: (a) => unsigned(a).toString('base64'),
      formatDate
    },
    Session: { getScriptTimeZone: () => TZ },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); },
        getProperties: () => Object.fromEntries(props)
      })
    }
  };
  vm.createContext(context);
  // GAS と同じく、全部のファイルを1つの場所で読む。const/let もテストから見えるように、最後に取り出す
  const files = readdirSync(root).filter((f) => f.endsWith('.gs')).sort();
  const names = new Set();
  let code = '';
  for (const f of files) {
    const src = readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/^(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    code += src + '\n';
  }
  code += '\n;({' + [...names].map((n) => n + ': typeof ' + n + " === 'undefined' ? undefined : " + n).join(', ') + '})';
  const G = vm.runInContext(code, context, { filename: 'gas-all.js' });
  // シートを読む関数などを、テストの中で差し替えるための入口（関数の宣言は、この場所のプロパティになる）
  Object.defineProperty(G, '$global', { value: context, enumerable: false });
  return G;
}
