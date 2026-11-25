/**
 * Db.gs … スプレッドシートの読み書きの土台
 *
 * - 列は「見出しの名前」で引く。列を並べ替えても、お客さんが列を足しても壊れない
 * - 読み込みはシートごとに1回（getDataRange().getValues()）。1回の実行の中では使い回す
 * - 書き込みは必ず withLock_() の中で行う
 * - 末尾がアンダースコアの関数は、画面（google.script.run）からは呼べない
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Db.gs'] = '0.138.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

let ss_ = null;
let tableCache_ = {};
let lockDepth_ = 0;          // withLock_ の中にいるか
let dirtySheets_ = {};       // この実行で書いたシート（サーバー側の控えを使えなくするために覚える）
let refMemo_ = {};           // この実行で読んだ「参照の控え」（スタッフ・設定・選択肢。v0.18.0）
let flushedInLock_ = false;   // ロックの中の flush が済んだか（releaseDirty_ が重ねて flush しないため。v0.88.0）
let fastCount_ = {};         // この実行で、1行だけ探した回数（シートごと。v0.18.0）

function hasDirtySheets_() {
  return Object.keys(dirtySheets_).length > 0;
}

/** シートに書いたら呼ぶ。ロックの中なら、ロックの終わりにまとめて控えを使えなくする */
function markDirty_(sheetName) {
  dirtySheets_[sheetName] = true;
  refMemo_ = {};
  if (lockDepth_ === 0) releaseDirty_();
}

function releaseDirty_() {
  const names = Object.keys(dirtySheets_);
  const skipFlush = flushedInLock_;
  flushedInLock_ = false;
  if (!names.length) return;
  // 書き込みがシートに届いてから、控えを使えなくする（順番が逆だと、古い中身が控えに入る）。
  // flush に失敗しても、控えは必ず使えなくする（書き込みが届いているかもしれないので）
  if (!skipFlush) { try { SpreadsheetApp.flush(); } catch (e) { console.warn('flush に失敗しました: ' + e); } }
  try { cacheBump_(names); } catch (e) { console.warn('控えを使えなくする処理に失敗しました: ' + e); }
  dirtySheets_ = {};
}

/** このスクリプトが紐づいているスプレッドシート */
function getSs_() {
  if (!ss_) ss_ = SpreadsheetApp.getActiveSpreadsheet();
  return ss_;
}

function scriptTz_() {
  return Session.getScriptTimeZone() || 'Asia/Tokyo';
}

function todayYmd_() {
  return Utilities.formatDate(new Date(), scriptTz_(), 'yyyy-MM-dd');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), scriptTz_(), 'yyyy-MM-dd HH:mm');
}

// ---------------------------------------------------------------------------
// エラーの扱い
//   画面に見せてよいエラーは appError_() で作る。それ以外の例外は中身を画面に出さない。
// ---------------------------------------------------------------------------
function appError_(code, message) {
  const e = new Error(message);
  e.appCode = code;
  return e;
}

/** 公開関数の共通の包み。{ok:true,...} か {ok:false,error,message} を返す */
function api_(fn) {
  try {
    const result = fn() || {};
    result.ok = true;
    return result;
  } catch (e) {
    if (e && e.appCode) return { ok: false, error: e.appCode, message: e.message };
    console.error('予期しないエラー: ' + (e && e.stack ? e.stack : e));
    return { ok: false, error: 'server', message: 'サーバーでエラーが起きました。少し待ってからもう一度試してください。' };
  }
}

/**
 * 大きな返事を小さくして返す（v0.107.0）。画面が pack: true を付けた時だけ。
 *   同じ形の記録が並ぶ配列 [{顧客ID:…, 顧客名:…}, …] を {__c:[列名], __r:[[値…], …]} にする。
 *   列名（日本語）を1件ごとに繰り返さないので、送る量がおよそ半分以下になる（スマホの電波で効く）。画面の call() が元に戻す。
 */
function apiPack_(params, fn) {
  const r = api_(fn);
  return params && params.pack === true && r && r.ok ? packRecords_(r) : r;
}
function packRecords_(v) {
  if (Array.isArray(v)) {
    if (v.length >= 8 && v.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); })) {
      const keys = Object.keys(v[0]);
      const sig = keys.join('\u0001');
      if (v.every(function (x) { return Object.keys(x).join('\u0001') === sig; })) {
        return { __c: keys, __r: v.map(function (x) { return keys.map(function (k) { return packRecords_(x[k]); }); }) };
      }
    }
    return v.map(packRecords_);
  }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = packRecords_(v[k]); });
    return out;
  }
  return v;
}

/** 書き込みの排他。中で読み直すので、ロック前に読んだ内容は使わないこと */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  // 20秒待って取れなければ、もう一度20秒待つ（収集ツールのPCがまとめて送ってきたときなど、混み合う時間をやり過ごすため。v0.61.1）
  const tLock = Date.now();
  try {
    lock.waitLock(20000);
  } catch (e) {
    try {
      lock.waitLock(20000);
    } catch (e2) {
      throw appError_('busy', '他の人の保存と重なりました。もう一度試してください。');
    }
  }
  const tBody = Date.now();
  try {
    tableCache_ = {};
    refMemo_ = {};
    lockDepth_++;
    const result = fn();
    SpreadsheetApp.flush();
    flushedInLock_ = true;      // 直後の releaseDirty_ では、もう一度 flush しない（v0.88.0）
    // 遅かった時だけログに残す（v0.110.0。毎回だと実行ログが埋まって、本当に見たいものが探しにくい）
    if (tBody - tLock > 3000 || Date.now() - tBody > 3000) console.warn('保存に時間がかかりました(ms) ロック待ち=' + (tBody - tLock) + ' 処理=' + (Date.now() - tBody));
    return result;
  } finally {
    lockDepth_--;
    tableCache_ = {};
    releaseDirty_();
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 型の変換
// ---------------------------------------------------------------------------
function typeMap_(sheetName) {
  const map = {};
  (SCHEMA[sheetName] || []).forEach(function (c) { map[c[0]] = c[1]; });
  return map;
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** 'yyyy-MM-dd'（または yyyy/M/d）を検証して 'yyyy-MM-dd' にそろえる。だめなら null */
function parseYmd_(s) {
  const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1900 || y > 2200) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

/** 'yyyy-MM-dd HH:mm'（区切りは空白かT）を検証してそろえる。だめなら null */
function parseYmdHm_(s) {
  const m = /^(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(s).trim());
  if (!m) return null;
  const ymd = parseYmd_(m[1]);
  const h = Number(m[2]), mi = Number(m[3]);
  if (!ymd || h > 23 || mi > 59) return null;
  return ymd + ' ' + pad2_(h) + ':' + pad2_(mi);
}

/** シートのセルの値 → 画面に渡す値（文字か数値） */
function fromCell_(type, v) {
  if (v === null || v === undefined || v === '') return '';
  const isDate = Object.prototype.toString.call(v) === '[object Date]';
  if (type === 'date') {
    if (isDate) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd');
    return parseYmd_(v) || (parseYmdHm_(v) || '').slice(0, 10);
  }
  if (type === 'datetime') {
    if (isDate) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd HH:mm');
    const d = parseYmdHm_(v);
    if (d) return d;
    const ymd = parseYmd_(v);
    return ymd ? ymd + ' 00:00' : '';
  }
  if (type === 'number') {
    if (typeof v === 'number') return isFinite(v) ? v : '';
    const n = Number(String(v).trim());
    return String(v).trim() !== '' && isFinite(n) ? n : '';
  }
  if (isDate) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd');
  return String(v);
}

/** 画面から来た値 → シートに書く値 */
function toCell_(type, v) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') {
    const ymd = parseYmd_(v);
    if (!ymd) return '';
    const p = ymd.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  if (type === 'datetime') {
    const s = parseYmdHm_(v);
    if (!s) return '';
    const p = s.split(/[- :]/);
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(p[3]), Number(p[4]));
  }
  if (type === 'number') {
    const n = Number(v);
    return isFinite(n) ? n : '';
  }
  const s = String(v);
  // 先頭が = + - @ ' の文字は、数式として解釈されないように ' を付けて文字として入れる。
  // （スプレッドシートは先頭の ' を「文字として扱う」印として取り除くので、読み戻すと元の文字になる）
  return /^[=+\-@']/.test(s) ? "'" + s : s;
}

function numberFormat_(type) {
  if (type === 'date') return 'yyyy-mm-dd';
  if (type === 'datetime') return 'yyyy-mm-dd hh:mm';
  if (type === 'number') return '0';
  if (type === 'text') return '@';
  return 'General';
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------
const HEAD_KEY = '#head:';     // tableCache_ の中で、見出しだけの控えに使うキーの頭
const LEAN_KEY = '#lean:';     // 同じく、重い列を抜いて読んだ表の控えに使うキーの頭

/** そのシートの行について覚えているものを忘れる（見出しは残す）。書いた後に呼ぶ */
function forgetRows_(sheetName) {
  delete tableCache_[sheetName];
  delete tableCache_[LEAN_KEY + sheetName];
}

/**
 * シートの値を読む。ふつうは1回で丸ごと読む。
 * 決めた列（SCHEMA）より列が多いシート（お客さんが足した列・移行で持ってきた列がある）は、
 * 決めた列のかたまりだけを読む。使わない列に長い文章が入っていても、読む量が増えない。
 * 読まなかった列は '' になる（見出しは全部入る）。
 */
function readSheetValues_(sheet, sheetName, types, lean) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const wanted = SCHEMA[sheetName] ? SCHEMA[sheetName].length : lastCol;
  if ((lastCol <= wanted && !lean) || lastRow < 2) return sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const head = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  // 決めた列が続いているところ（かたまり）を拾う [開始, 長さ]
  const runs = [];
  head.forEach(function (h, j) {
    if (types[String(h).trim()] === undefined) return;
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === j) last[1]++; else runs.push([j, 1]);
  });
  // かたまりが多いと、読む回数のほうが高くつく。その時は丸ごと読む
  if (!runs.length || runs.length > 4) return sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const values = [head];
  for (let i = 1; i < lastRow; i++) values.push(new Array(lastCol).fill(''));
  runs.forEach(function (run) {
    const part = sheet.getRange(2, run[0] + 1, lastRow - 1, run[1]).getValues();
    for (let i = 0; i < part.length; i++) {
      for (let k = 0; k < run[1]; k++) values[i + 1][run[0] + k] = part[i][k];
    }
  });
  return values;
}

/**
 * シートと見出しだけが要るとき（行を足す・1行を書き換える）。
 * すでに丸ごと読んであればそれを使い、無ければ見出しの1行だけを読む（表を丸ごと読まない）。
 * @return {{sheet:Object, headers:Array<string>}}
 */
function tableHead_(sheetName) {
  if (tableCache_[sheetName]) return tableCache_[sheetName];
  if (tableCache_[HEAD_KEY + sheetName]) return tableCache_[HEAD_KEY + sheetName];
  const sheet = getSs_().getSheetByName(sheetName);
  if (!sheet) throw appError_('setup', '「' + sheetName + '」シートがありません。スプレッドシートのメニューから初期設定を実行してください。');
  const lastCol = sheet.getLastColumn();
  const headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  const head = { sheet: sheet, headers: headers };
  tableCache_[HEAD_KEY + sheetName] = head;
  return head;
}

/**
 * 画面で保存する前に、そのシートに足りない列を右端に足す（v0.103.0）。
 * 「初期設定」を実行する前でも、後から増えた列（ひとこと など）の値が、黙って捨てられないように。
 * 今ある列と値には触らない。withLock_ の中で呼ぶこと。
 */
function ensureColumns_(sheetName) {
  const schema = SCHEMA[sheetName];
  if (!schema) return;
  const head = tableHead_(sheetName);
  const missing = schema.map(function (c) { return c[0]; }).filter(function (n) { return head.headers.indexOf(n) === -1; });
  if (!missing.length) return;
  const sheet = head.sheet;
  const lastCol = sheet.getLastColumn();
  const need = lastCol + missing.length;
  if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
  sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  forgetSheet_(sheetName);
}

/** そのシートについて覚えているもの（中身・見出し）を忘れる。列を動かした後に呼ぶ */
function forgetSheet_(sheetName) {
  forgetRows_(sheetName);
  delete tableCache_[HEAD_KEY + sheetName];
}

/**
 * シートに書いた行を、読み戻したときと同じ形にする（書いた後に表を読み直さないで、返事を作るため）。
 * @param {Object} base 書く前の行（新しい行なら null）
 * @param {Object} changes 書いた値
 */
function echoRow_(sheetName, base, changes) {
  const headers = tableHead_(sheetName).headers;
  const out = {};
  if (base && base._row) out._row = base._row;
  SCHEMA[sheetName].forEach(function (c) {
    const h = c[0], type = c[1];
    if (headers.indexOf(h) === -1) return;
    const v = changes && changes[h] !== undefined ? changes[h] : (base && base[h] !== undefined ? base[h] : '');
    if (v === '' || v === null || v === undefined) out[h] = '';
    else if (type === 'text') out[h] = String(v);
    else out[h] = fromCell_(type, toCell_(type, v));
  });
  return out;
}
/**
 * シートを丸ごと読んで、見出しをキーにしたオブジェクトの配列にする。
 * @return {{sheet:Object, headers:Array<string>, rows:Array<Object>}} rows の各要素は _row（行番号）を持つ
 */
function readTable_(sheetName, skip) {
  if (tableCache_[sheetName]) return tableCache_[sheetName];
  const sheet = getSs_().getSheetByName(sheetName);
  if (!sheet) throw appError_('setup', '「' + sheetName + '」シートがありません。スプレッドシートのメニューから初期設定を実行してください。');
  const types = typeMap_(sheetName);
  // skip … 読まない列（重い列）。その列は行に入らない。同じ実行の中で同じ読み方をしたら、使い回す（書いたら忘れる）
  const lean = !!(skip && skip.length);
  const leanKey = lean ? skip.join('\u0001') : '';
  if (lean && tableCache_[LEAN_KEY + sheetName] && tableCache_[LEAN_KEY + sheetName][leanKey]) return tableCache_[LEAN_KEY + sheetName][leanKey];
  if (lean) skip.forEach(function (h) { delete types[h]; });
  const values = readSheetValues_(sheet, sheetName, types, lean);
  const headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  tableCache_[HEAD_KEY + sheetName] = { sheet: sheet, headers: headers };
  // アプリが読むのは、決めた列（SCHEMA）だけ。シートに足してある列（お客さんが足した列・移行で持ってきた列）は、
  // シートには残るが、アプリには渡さない（画面にも送られない。パスワードなどが入っていても漏れない）
  const known = !!SCHEMA[sheetName];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    let empty = true;
    const obj = { _row: i + 1 };
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      if (!h || (known && types[h] === undefined)) continue;
      const val = fromCell_(types[h] || 'text', r[j]);
      if (val !== '') empty = false;
      obj[h] = val;
    }
    if (!empty) rows.push(obj);
  }
  const table = { sheet: sheet, headers: headers, rows: rows };
  if (!lean) tableCache_[sheetName] = table;
  else {
    tableCache_[LEAN_KEY + sheetName] = tableCache_[LEAN_KEY + sheetName] || {};
    tableCache_[LEAN_KEY + sheetName][leanKey] = table;
  }
  return table;
}

function findById_(sheetName, idField, id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  // 表をまだ読んでいなければ、IDの列から1行だけ探して、その行だけを読む（v0.18.0。保存のたびに表を丸ごと読まない）
  if (!tableCache_[sheetName]) {
    const fast = findRowFast_(sheetName, idField, want);
    if (fast !== undefined) return fast;
  }
  const rows = readTable_(sheetName).rows;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idField]) === want) return rows[i];
  }
  return null;
}

/**
 * IDの列を TextFinder で探して、見つかった1行だけを読む。readTable_ と同じ形の行を返す。
 * 同じ実行の中で同じシートを何度も探す時は、3回めから表を丸ごと読む（そのほうが速い）。
 * @return {Object|null|undefined} 見つからなければ null、この方法が使えない時は undefined（ふつうに探す）
 */
function findRowFast_(sheetName, idField, want) {
  fastCount_[sheetName] = (fastCount_[sheetName] || 0) + 1;
  if (fastCount_[sheetName] > 2) return undefined;
  const head = tableHead_(sheetName);
  const col = head.headers.indexOf(idField);
  if (col === -1) return undefined;
  const sheet = head.sheet;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  let cell;
  try {
    cell = sheet.getRange(2, col + 1, lastRow - 1, 1).createTextFinder(want).matchCase(true).matchEntireCell(true).findNext();
  } catch (e) { return undefined; }
  if (!cell) return undefined;      // 見つからない時は、念のためふつうに探す（表示の違う値も拾うため）
  const rowNumber = cell.getRow();
  const values = sheet.getRange(rowNumber, 1, 1, head.headers.length).getValues()[0];
  const types = typeMap_(sheetName);
  const known = !!SCHEMA[sheetName];
  const obj = { _row: rowNumber };
  head.headers.forEach(function (h, j) {
    if (!h || (known && types[h] === undefined)) return;
    obj[h] = fromCell_(types[h] || 'text', values[j]);
  });
  // 見た目は同じでも値が違う（数として入っている・前後に空白がある など）ときは、ふつうに探す
  return String(obj[idField]) === want ? obj : undefined;
}

/**
 * v0.126.0：ある列が value の行だけを返す（readTable_ と同じ形）。表をまだ読んでいなければ、TextFinder でその列から探して、
 *   見つかった行だけを読む（対応履歴のような大きい表を、丸ごと読まない）。見つかった行が多い時や、使えない時は、表を読んで絞る。
 */
function rowsWhere_(sheetName, colName, value) {
  const want = String(value === null || value === undefined ? '' : value).trim();
  if (!want) return [];
  const slow = function () { return readTable_(sheetName).rows.filter(function (r) { return String(r[colName]) === want; }); };
  if (tableCache_[sheetName]) return slow();
  const head = tableHead_(sheetName);
  if (!head || !head.sheet) return [];
  const col = head.headers.indexOf(colName);
  if (col === -1) return [];
  const sheet = head.sheet, lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  let cells;
  try {
    cells = sheet.getRange(2, col + 1, lastRow - 1, 1).createTextFinder(want).matchCase(true).matchEntireCell(true).findAll();
  } catch (e) { return slow(); }
  if (!cells || !cells.length) return [];
  if (cells.length > 40) return slow();          // 多い時は、1行ずつ読むより丸ごと読むほうが速い
  const types = typeMap_(sheetName), known = !!SCHEMA[sheetName], width = head.headers.length;
  const out = [];
  cells.forEach(function (cell) {
    const rowNumber = cell.getRow(), values = sheet.getRange(rowNumber, 1, 1, width).getValues()[0];
    const obj = { _row: rowNumber };
    head.headers.forEach(function (h, j) { if (h && !(known && types[h] === undefined)) obj[h] = fromCell_(types[h] || 'text', values[j]); });
    if (String(obj[colName]) === want) out.push(obj);
  });
  return out;
}

/** _row を外した写し */
function publicRecord_(row, omit) {
  const out = {};
  Object.keys(row).forEach(function (k) {
    if (k === '_row') return;
    if (omit && omit.indexOf(k) !== -1) return;
    out[k] = row[k];
  });
  return out;
}

// ---------------------------------------------------------------------------
// 書き込み（withLock_ の中で呼ぶこと）
// ---------------------------------------------------------------------------
/** 末尾に追加する。objs は見出しをキーにしたオブジェクトの配列 */
function appendRecords_(sheetName, objs) {
  if (!objs || !objs.length) return;
  const table = tableHead_(sheetName);      // 見出しだけあればよい（変更履歴のような長いシートを、足すたびに丸ごと読まない）
  const sheet = table.sheet;
  const headers = table.headers;
  const types = typeMap_(sheetName);
  const n = headers.length;
  const values = objs.map(function (obj) {
    return headers.map(function (h) {
      return obj[h] === undefined ? '' : toCell_(types[h] || 'text', obj[h]);
    });
  });
  const start = sheet.getLastRow() + 1;
  const need = start + objs.length - 1;
  let max = sheet.getMaxRows();
  if (need > max) { sheet.insertRowsAfter(max, need - max + 100); max = need + 100; }
  // 決めた列に無い列（足してある列）は、文字として入れる（「001」や日付のような文字が、勝手に数や日付に変わらないように）。
  // 書式は、空いている行のぶんを前もってまとめて付けておき（印を残す）、足すたびには付けない（v0.97.0）
  ensureBlankFormats_(sheetName, sheet, headers, types, start, max);
  sheet.getRange(start, 1, objs.length, n).setValues(values);
  forgetRows_(sheetName);
  markDirty_(sheetName);
}

/**
 * 空いている行（start から最後まで）に、列ごとの書式を付けておく。付けたら印（行数と見出しの形）を残し、
 * 次からは、印が同じなら何もしない。行が増えた・減った・見出しが変わった時は、印が合わなくなるので付け直す。
 */
function ensureBlankFormats_(sheetName, sheet, headers, types, start, max) {
  if (max < start) return;
  const props = PropertiesService.getScriptProperties();
  const key = FORMAT_MARK_PREFIX + sheetName;
  let sum = 5381;
  const text = headers.join('\u0001');
  for (let i = 0; i < text.length; i++) sum = ((sum * 33) ^ text.charCodeAt(i)) >>> 0;
  const mark = max + ':' + headers.length + ':' + sum;
  if (props.getProperty(key) === mark) return;
  const formatRow = headers.map(function (h) { return numberFormat_(types[h] || 'text'); });
  const rows = [];
  for (let r = start; r <= max; r++) rows.push(formatRow);
  sheet.getRange(start, 1, max - start + 1, headers.length).setNumberFormats(rows);
  props.setProperty(key, mark);
}

/**
 * 末尾の limit 行だけを読む（変更履歴のように、長くなるシートの「最近のぶん」だけが要る時）。
 * @return {{total:number, rows:Array<Object>}} total は全体の行数。rows は古い順
 */
function readTailRows_(sheetName, limit) {
  if (tableCache_[sheetName]) {
    const all = tableCache_[sheetName].rows;
    return { total: all.length, rows: all.slice(-limit) };
  }
  const head = tableHead_(sheetName);
  const sheet = head.sheet;
  const lastRow = sheet.getLastRow();
  const total = Math.max(0, lastRow - 1);
  if (!total) return { total: 0, rows: [] };
  const first = Math.max(2, lastRow - limit + 1);
  const types = typeMap_(sheetName);
  const known = !!SCHEMA[sheetName];
  const values = sheet.getRange(first, 1, lastRow - first + 1, head.headers.length).getValues();
  const rows = [];
  values.forEach(function (r, i) {
    let empty = true;
    const obj = { _row: first + i };
    head.headers.forEach(function (h, j) {
      if (!h || (known && types[h] === undefined)) return;
      const val = fromCell_(types[h] || 'text', r[j]);
      if (val !== '') empty = false;
      obj[h] = val;
    });
    if (!empty) rows.push(obj);
  });
  return { total: total, rows: rows };
}

function appendRecord_(sheetName, obj) {
  appendRecords_(sheetName, [obj]);
}

/** 1行を書き換える。changes にある列だけ変える（スキーマに無い列・渡していない列は触らない） */
function updateRecord_(sheetName, rowNumber, changes) {
  const table = tableHead_(sheetName);
  const headers = table.headers;
  const types = typeMap_(sheetName);
  // 変える列だけを書く。触らない列（お客さんが足した列・数式・文字として入れてある「007」など）には、書き戻さない
  // （行を丸ごと書き戻すと、書式が「標準」の列の文字が、数や日付に変わってしまう）
  const cols = [];
  headers.forEach(function (h, j) { if (h && changes[h] !== undefined) cols.push(j); });
  let i = 0;
  while (i < cols.length) {
    // 続いている列は、1回でまとめて書く
    let k = i;
    while (k + 1 < cols.length && cols[k + 1] === cols[k] + 1) k++;
    const values = cols.slice(i, k + 1).map(function (j) { return toCell_(types[headers[j]] || 'text', changes[headers[j]]); });
    table.sheet.getRange(rowNumber, cols[i] + 1, 1, values.length).setValues([values]);
    i = k + 1;
  }
  forgetRows_(sheetName);
  markDirty_(sheetName);
}

/** 列の番号（1始まり）→ A1 形式の列の文字（1→A、27→AA） */
function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * 何行かに、同じ値をまとめて書く（v0.106.0）。列ごとに1回の書き込みで済む（行ごとに書くと、行の数だけ時間がかかる）。
 * 機器の顧客を移す時の「顧客ID」「更新日時」などに使う。触らない列には書かない。
 * @param {string} sheetName
 * @param {number[]} rowNumbers シートの行番号
 * @param {Object} changes 列名 → 値（全部の行に同じ値）
 */
function updateRowsSame_(sheetName, rowNumbers, changes) {
  const rows = (rowNumbers || []).filter(function (r) { return Number(r) >= 2; });
  if (!rows.length) return;
  if (rows.length === 1) { updateRecord_(sheetName, rows[0], changes); return; }
  const table = tableHead_(sheetName);
  const types = typeMap_(sheetName);
  table.headers.forEach(function (h, j) {
    if (!h || changes[h] === undefined) return;
    const letter = colLetter_(j + 1);
    // RangeList は1回に多すぎると重くなるので、500行ずつに分ける
    for (let i = 0; i < rows.length; i += 500) {
      table.sheet.getRangeList(rows.slice(i, i + 500).map(function (r) { return letter + r; })).setValue(toCell_(types[h] || 'text', changes[h]));
    }
  });
  forgetRows_(sheetName);
  markDirty_(sheetName);
}

function deleteRecord_(sheetName, rowNumber) {
  tableHead_(sheetName).sheet.deleteRow(rowNumber);
  forgetRows_(sheetName);
  markDirty_(sheetName);
}

/** 連番のID（例：C0001）。withLock_ の中で呼ぶこと */
function nextId_(sheetName, idField, prefix, digits) {
  const re = new RegExp('^' + prefix + '(\\d+)$');
  let max = 0;
  const see = function (v) {
    const m = re.exec(String(v));
    if (m) max = Math.max(max, Number(m[1]));
  };
  const fmt = function (n) { let s = String(n); while (s.length < digits) s = '0' + s; return prefix + s; };
  // v0.136.0：前に使った番号を覚えておき、ID の列を全部は読まない（対応が数千件あると、新しく記録するたびにここで時間を使っていた）
  //   覚えた番号と、一番下の行の番号の大きいほうの次を使う。念のため、その番号がもう無いかを探して、あれば今までどおり全部読む
  const memoKey = 'idnext_' + sheetName;
  let props = null;
  try { props = PropertiesService.getScriptProperties(); } catch (e) { props = null; }
  const remember = function (id) { try { if (props) props.setProperty(memoKey, String(Number(re.exec(id)[1]))); } catch (e) { /* 覚えられなくても、次は全部読むだけ */ } };
  const floorOf = function (key) { try { return props ? Number(props.getProperty(key)) || 0 : 0; } catch (e) { return 0; } };
  if (!tableCache_[sheetName]) {
    const memo = floorOf(memoKey);
    const head = tableHead_(sheetName);
    const col = head.headers.indexOf(idField);
    const lastRow = head.sheet.getLastRow();
    if (memo > 0 && col !== -1) {
      if (lastRow >= 2) see(head.sheet.getRange(lastRow, col + 1).getValue());
      max = Math.max(max, memo);
      if (sheetName === SHEET_ACTIVITIES) max = Math.max(max, floorOf('idfloor_' + sheetName));
      const want = fmt(max + 1);
      let taken = null;
      try { taken = lastRow >= 2 ? head.sheet.getRange(2, col + 1, lastRow - 1, 1).createTextFinder(want).matchCase(true).matchEntireCell(true).findNext() : null; } catch (e) { taken = 'unknown'; }
      if (!taken) { remember(want); return want; }
      max = 0;      // 覚えた番号より大きい番号が、手で足されている。下で全部読む
    }
  }
  if (tableCache_[sheetName]) {
    tableCache_[sheetName].rows.forEach(function (r) { see(r[idField]); });
  } else {
    // 表をまだ読んでいなければ、IDの列だけを読む（番号を決めるためだけに、表を丸ごと読まない）
    const head = tableHead_(sheetName);
    const col = head.headers.indexOf(idField);
    const lastRow = head.sheet.getLastRow();
    if (col !== -1 && lastRow >= 2) head.sheet.getRange(2, col + 1, lastRow - 1, 1).getValues().forEach(function (r) { see(r[0]); });
  }
  // 退避シートへ移した番号も、もう使わない（v0.112.0）
  if (sheetName === SHEET_ACTIVITIES) max = Math.max(max, floorOf('idfloor_' + sheetName));
  const next = fmt(max + 1);
  remember(next);
  return next;
}

// ---------------------------------------------------------------------------
// 設定・選択肢
// ---------------------------------------------------------------------------
/** 設定シートを {キー: 値} にする。シートに無いキーは既定値（v0.18.0：普段は控えから。ロックの中はシートから） */
function getSettings_() {
  return refPart_('refSettings');
}
function readSettingsDirect_() {
  const map = {};
  SETTING_DEFAULTS.forEach(function (d) { map[d[0]] = d[1]; });
  readTable_(SHEET_SETTINGS).rows.forEach(function (r) {
    const key = String(r['キー']).trim();
    if (key) map[key] = String(r['値']);
  });
  return map;
}

function settingDays_(settings, key, fallback) {
  const n = parseInt(settings[key], 10);
  return isFinite(n) && n >= 0 && n <= 3650 ? n : fallback;
}

/** 選択肢シートを {区分: [{value, active}]} にする（表示順で並べる。v0.18.0：普段は控えから） */
function getOptions_() {
  return refPart_('refOptions');
}
function readOptionsDirect_() {
  const out = {};
  OPTION_CATEGORIES.forEach(function (c) { out[c] = []; });
  Object.keys(OPTION_BASE).forEach(function (c) {
    out[c] = OPTION_BASE[c].map(function (v) { return { value: v, active: true, locked: true }; });
  });
  const rows = readTable_(SHEET_OPTIONS).rows.slice();
  rows.sort(function (a, b) { return (Number(a['表示順']) || 0) - (Number(b['表示順']) || 0); });
  rows.forEach(function (r) {
    const cat = String(r['区分']).trim();
    const val = String(r['値']).trim();
    if (!out[cat] || !val) return;
    if (OPTION_BASE[cat] && OPTION_BASE[cat].indexOf(val) !== -1) return;
    out[cat].push({ value: val, active: r['有効'] !== NO });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 変更履歴
// ---------------------------------------------------------------------------
function auditText_(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}

/** 変更履歴に1行足す。withLock_ の中で呼ぶこと */
function logAudit_(kind, target, customerId, field, before, after, actor) {
  appendRecord_(SHEET_AUDIT, {
    '日時': nowStamp_(),
    '種別': kind,
    '対象': auditText_(target),
    '顧客ID': customerId || '',
    '項目': auditText_(field),
    '変更前': auditText_(before),
    '変更後': auditText_(after),
    '実行者': actor || ''
  });
}

// =============================================================================
// ここから：元 Cache.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Cache.gs … 画面を開く時に渡すデータの「控え」（サーバー側のキャッシュ）
 *
 * 画面を開くたびにシートを全部読むと時間がかかるので、画面に渡す形にしたものを CacheService に控えておく。
 *
 * しくみ
 *   - 控えは「部品」ごと（顧客・機器・対応履歴・要対応…）。どの部品がどのシートから作られるかは Config.gs の CACHE_DEPS
 *   - シートごとに「版の印」を持つ。アプリがそのシートに書いたら、印を新しくする（Db.gs の withLock_ の終わり）
 *   - 部品の控えの頭には、作った時の「元のシートの印」を付けてある。読む時に、今の印と違えば使わない
 *     （消し忘れが起きない。キーは部品ごとに決まっていて上書きになるので、古い控えが溜まらない）
 *   - スプレッドシートを手で直した時は onEdit が印を新しくする。行の削除などは onEdit が動かないので、
 *     その時は最長で SERVER_CACHE_SECONDS のあいだ古いまま（画面の「最新を読み込む」で、すぐ読み直せる）
 *   - CacheService が使えない・値が大きすぎる、などの時は、何も言わずにシートを直接読む（遅くなるだけで、止まらない）
 *
 * 公開関数：onEdit（スプレッドシートを手で直した時に、Google が呼ぶ）
 */

const CACHE_GEN_ALL = 'gen_all';     // 全部の控えを使えなくするための印
const CACHE_GEN_SECONDS = 21600;

let cacheGens_ = null;               // この実行で最初に読んだ印（シートを読む前に取っておく）
let cacheStats_ = { hit: 0, miss: 0 };
let cacheFresh_ = false;             // この実行では控えを読まない（「最新を読み込む」。作ったものは控える）
let cacheWatched_ = null;
let cacheWarmOnly_ = false;          // 控えに無い部品があったら、作らずにやめる（ログインの返事に、残りのデータを付けるかどうか。v0.20.0）

function cacheOn_() {
  return SERVER_CACHE_SECONDS > 0;
}

/** 控えのもとになっているシートの名前 → 番号（キーに日本語を入れないため） */
function cacheWatchedSheets_() {
  if (cacheWatched_) return cacheWatched_;
  const map = {};
  Object.keys(CACHE_DEPS).forEach(function (part) {
    CACHE_DEPS[part].forEach(function (name) { map[name] = SHEET_ORDER.indexOf(name); });
  });
  cacheWatched_ = map;
  return map;
}

function cacheGenKey_(sheetName) {
  return 'gen_' + cacheWatchedSheets_()[sheetName];
}

function cacheNewGen_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

/**
 * 今の印をまとめて読む（1回の実行で1回だけ）。シートを読む前に呼ぶこと。
 * 先にシートを読んでから印を読むと、その間に他の人が保存した時、古い中身を新しい印で控えてしまう。
 * @return {Object|null} {キー: 印}。キャッシュが使えない時は null
 */
function cachePrime_() {
  if (!cacheOn_()) return null;
  if (cacheGens_) return cacheGens_;
  try {
    const cache = CacheService.getScriptCache();
    const keys = [CACHE_GEN_ALL].concat(Object.keys(cacheWatchedSheets_()).map(cacheGenKey_));
    const got = cache.getAll(keys) || {};
    const fresh = {};
    let missing = false;
    keys.forEach(function (k) {
      if (typeof got[k] === 'string' && got[k]) return;
      got[k] = fresh[k] = cacheNewGen_();
      missing = true;
    });
    if (missing) cache.putAll(fresh, CACHE_GEN_SECONDS);
    cacheGens_ = got;
  } catch (e) {
    console.warn('控えの印を読めませんでした: ' + e);
    cacheGens_ = null;
  }
  return cacheGens_;
}

/**
 * シートに書いた後に呼ぶ。そのシートから作った控えを、使えなくする。
 * @param {Array<string>} sheetNames
 */
function cacheBump_(sheetNames) {
  cacheGens_ = null;
  if (!cacheOn_()) return;
  const watched = cacheWatchedSheets_();
  const map = {};
  let any = false;
  (sheetNames || []).forEach(function (name) {
    if (watched[name] === undefined) return;       // スタッフ・変更履歴など、控えに関係しないシート
    map[cacheGenKey_(name)] = cacheNewGen_();
    any = true;
  });
  if (!any) return;
  cachePutGens_(map);
}

/** 全部の控えを使えなくする（初期設定のあと・「最新を読み込む」）。自社名・ロゴ・Tips の控えも消す */
function cacheBumpAll_() {
  cacheGens_ = null;
  cacheDropSmall_();
  if (!cacheOn_()) return;
  const map = {};
  map[CACHE_GEN_ALL] = cacheNewGen_();
  cachePutGens_(map);
}

/** 自社名・ロゴ・Tips の控え（10分もの）を消す */
function cacheDropSmall_() {
  try { CacheService.getScriptCache().removeAll([BRAND_CACHE_KEY, TIPS_CACHE_KEY]); } catch (e) { /* 10分で切れる */ }
}

function cachePutGens_(map) {
  // 印を新しくできないと、古い控えが残る。1回だけやり直す
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      CacheService.getScriptCache().putAll(map, CACHE_GEN_SECONDS);
      return;
    } catch (e) {
      if (attempt === 1) console.warn('控えの印を新しくできませんでした: ' + e);
    }
  }
}

/** 部品の控えのキー（部品と、何個めか。印は値の頭に入れる） */
function cachePartKey_(part, i) {
  return 'pc_' + part + '_' + i;
}

/** 部品の控えのキーに入れる印（版・全体の印・元のシートの印・日付など） */
function cachePartSig_(part, gens, extra) {
  const bits = [APP_VERSION, gens[CACHE_GEN_ALL]];
  CACHE_DEPS[part].forEach(function (name) { bits.push(gens[cacheGenKey_(name)]); });
  bits.push(extra || '');
  return sha256Hex_(bits.join('|')).slice(0, 20);
}

/**
 * 長い文字を、CacheService に入る大きさに切る（1つ100KBまで。日本語は1文字3バイトなので、文字数で余裕を見る）。
 * 絵文字（2つで1文字）の真ん中では切らない。
 * @return {Array<string>|null} 多すぎる時は null（控えない）
 */
function cacheSplit_(text) {
  const chunks = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + CACHE_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end--;
    }
    chunks.push(text.slice(at, end));
    at = end;
    if (chunks.length > CACHE_MAX_CHUNKS) return null;
  }
  if (!chunks.length) chunks.push('');
  chunks[0] = chunks.length + ':' + chunks[0];
  return chunks;
}

/**
 * 読んだ控えを、元の値に戻す。どの切れ端も、頭に「印:」が付いている。
 * 印が今のものと違う（＝元のシートが変わった・別の実行が途中まで上書きした）・そろっていない・壊れている時は undefined
 */
function cacheJoin_(found, part, sig) {
  const head = sig + ':';
  const first = found[cachePartKey_(part, 0)];
  if (typeof first !== 'string' || first.indexOf(head) !== 0) return undefined;
  const m = /^(\d{1,2}):/.exec(first.slice(head.length, head.length + 4));
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 1 || n > CACHE_MAX_CHUNKS) return undefined;
  let text = first.slice(head.length + m[0].length);
  for (let i = 1; i < n; i++) {
    const piece = found[cachePartKey_(part, i)];
    if (typeof piece !== 'string' || piece.indexOf(head) !== 0) return undefined;
    text += piece.slice(head.length);
  }
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? undefined : value;
  } catch (e) {
    return undefined;
  }
}

/**
 * 部品をまとめて取る。控えがあればそれを、無ければシートから作って、控えておく。
 * 書き込みの途中（ロックの中）・書いた直後は、控えを使わない（必ずシートを読む）。
 * @param {Array<string>} parts CACHE_DEPS にある名前
 * @param {Object<string, function():*>} builders 部品を作る関数
 * @param {Object<string, string>=} extras 部品ごとに、キーに足す文字（日付など）
 * @return {Object<string, *>}
 */
function cachedParts_(parts, builders, extras, allowLock) {
  const out = {};
  const direct = function (part) { out[part] = builders[part](); };
  // この実行で書いたシートから作る部品だけ、控えを使わない（v0.20.0。前は、どれか1枚でも書いたら全部使わなかった）
  const touched = parts.some(function (part) { return (CACHE_DEPS[part] || []).some(function (name) { return dirtySheets_[name]; }); });
  const gens = ((lockDepth_ > 0 && !allowLock) || touched) ? null : cachePrime_();
  if (!gens) {
    parts.forEach(direct);
    return out;
  }
  const sigs = {};
  let found = {};
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const keys = [];
    parts.forEach(function (part) {
      sigs[part] = cachePartSig_(part, gens, extras && extras[part]);
      for (let i = 0; i < CACHE_MAX_CHUNKS; i++) keys.push(cachePartKey_(part, i));
    });
    // 「最新を読み込む」の時は、控えを読まずに作って、上書きする（印を新しくできなかったときでも、必ず新しくなる）
    found = cacheFresh_ ? {} : (cache.getAll(keys) || {});
  } catch (e) {
    console.warn('控えを読めませんでした: ' + e);
    parts.forEach(direct);
    return out;
  }

  const fresh = [];
  parts.forEach(function (part) {
    const hit = cacheJoin_(found, part, sigs[part]);
    if (hit !== undefined) {
      out[part] = hit;
      cacheStats_.hit++;
      return;
    }
    if (cacheWarmOnly_) throw { cacheWarmMiss: true };
    direct(part);
    cacheStats_.miss++;
    fresh.push(part);
  });

  // 作ったものを控える。何回かに分けて入れる（1回に入れる量を大きくしすぎない）
  let batch = {}, size = 0, batchTtl = 0;
  const send = function () {
    if (!size) return;
    try { cache.putAll(batch, batchTtl); } catch (e) { console.warn('控えを入れられませんでした: ' + e); }
    batch = {}; size = 0;
  };
  fresh.forEach(function (part) {
    const ttl = Math.min(SERVER_CACHE_SECONDS, CACHE_TTL[part] || SERVER_CACHE_SECONDS);
    if (size && ttl !== batchTtl) send();
    batchTtl = ttl;
    let chunks = null;
    try { chunks = cacheSplit_(JSON.stringify(out[part])); } catch (e) { chunks = null; }
    if (!chunks) {
      // 大きすぎて控えられない部品は、毎回シートから読み直しになる（v0.41.0：ログに残す。メニュー「控えの状態を調べる」でも分かる）
      console.warn('控えられません（大きすぎます）: ' + part);
      return;
    }
    chunks.forEach(function (piece, i) {
      if (size && size + piece.length > CACHE_PUT_CHARS) send();
      batch[cachePartKey_(part, i)] = sigs[part] + ':' + piece;
      size += piece.length;
    });
  });
  send();
  return out;
}

/** この実行で、控えを使えた数・作り直した数（画面の「読み込み」の行に出す） */
function cacheStatsNow_() {
  return { hit: cacheStats_.hit, miss: cacheStats_.miss };
}

/**
 * スプレッドシートを手で直したとき（Google が自動で呼ぶ）。直したシートの控えを、使えなくする。
 * 行の削除・挿入、スクリプトからの書き込みでは呼ばれない。
 */
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if (typeof name !== 'string' || !name) return;
    cacheBump_([name]);
    if (name === SHEET_SETTINGS || name === SHEET_TIPS) cacheDropSmall_();
  } catch (err) { /* 控えは、時間がたてば新しくなる */ }
}

// ---------------------------------------------------------------------------
// 参照の控え（v0.18.0）：スタッフ・設定・選択肢
//   どの呼び出しでも読む小さいシート（ログインの確認・設定・選択肢）を、シートでなく控えから読む。
//   書いたら印が変わるので、古いものは使わない。ロックの中・書いた直後は、シートから読む（cachedParts_ と同じ）。
//   スタッフの控えには、パスワードのハッシュは入れない（確かめるための印だけ）。
// ---------------------------------------------------------------------------
function refBuilders_() {
  return {
    refSettings: readSettingsDirect_,
    refOptions: readOptionsDirect_,
    refStaff: function () {
      return readTable_(SHEET_STAFF).rows.map(function (r) {
        return {
          id: normStaffId_(r['スタッフID']), rawId: String(r['スタッフID']), name: String(r['表示名'] || r['スタッフID']),
          enabled: r['有効'] === YES, role: r['権限'] === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF,
          stamp: passwordStamp_(r['パスワードハッシュ']), start: staffStartView_(r)
        };
      });
    }
  };
}
/** 参照の控えを1つ。同じ実行の中では1回だけ読む */
function refPart_(part) {
  if (Object.prototype.hasOwnProperty.call(refMemo_, part)) return refMemo_[part];
  const stats = { hit: cacheStats_.hit, miss: cacheStats_.miss };     // 画面の「控え ○/○」には数えない
  const value = cachedParts_([part], refBuilders_())[part];
  cacheStats_ = stats;
  refMemo_[part] = value;
  return value;
}
/** スタッフ1人（控えから）。いなければ null */
function staffRef_(staffId) {
  const id = normStaffId_(staffId);
  if (!id) return null;
  return refPart_('refStaff').filter(function (s) { return s.id === id; })[0] || null;
}

/**
 * 顧客・機器が「あるか」「どの顧客のものか」を、控えで確かめる（v0.18.0。保存のたびに顧客・機器のシートを丸ごと読まない）。
 * ロックの中でも使う。ロックを取った後に印を読み直すので、他の人が書き終えたものは見える。
 * この実行で書いたシートがある時は、シートを読む。行番号（_row）は無い（書きかえには使わないこと）。
 */
function cachedFind_(part, sheetName, idField, id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  if (!cacheOn_() || hasDirtySheets_()) return findById_(sheetName, idField, want);
  if (lockDepth_ > 0) cacheGens_ = null;
  let list;
  try { list = cachedParts_([part], bootBuilders_(), null, true)[part]; } catch (e) { list = null; }
  if (!Array.isArray(list)) return findById_(sheetName, idField, want);
  for (let i = 0; i < list.length; i++) if (String(list[i][idField]) === want) return list[i];
  return null;
}

/**
 * 残りのデータのうち、控えだけで作れるグループだけを作る（ログインの返事に付ける。v0.20.0／グループごと v0.69.0）。
 * 控えに無いグループは入れない（返事の groups に、入れたものだけ書く。画面が、要るぶんをあとで別に読む）。
 * 1つも作れなければ null。最初の画面を出すのが遅くならないように、シートは読まない。
 */
function bootRestIfWarm_(me) {
  if (!cacheOn_()) return null;
  cacheWarmOnly_ = true;
  let merged = null;
  try {
    Object.keys(bootGroupDefs_()).forEach(function (g) {
      let part;
      try { part = bootRest_(me, [g]); } catch (e) { if (e && e.cacheWarmMiss) return; throw e; }
      if (!merged) merged = { groups: [], restMs: 0, restCache: { hit: 0, miss: 0 } };
      Object.keys(part).forEach(function (k) {
        if (k === 'groups') merged.groups = merged.groups.concat(part.groups);
        else if (k === 'restMs') merged.restMs += part.restMs;
        else if (k === 'restCache') { merged.restCache.hit += part.restCache.hit; merged.restCache.miss += part.restCache.miss; }
        else merged[k] = part[k];
      });
    });
    return merged;
  } catch (e) {
    console.warn('ログインの返事に残りのデータを付けられませんでした: ' + e);
    return null;
  } finally {
    cacheWarmOnly_ = false;
  }
}

/**
 * メニュー：控えの状態を調べる（v0.41.0）。
 * 部品ごとに、中身の大きさ・何個に分けるか・今控えに入っているかを出す。「読み込み：控え 0/20」が続く時の原因探し。
 */
function cacheReport() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const lines = [];
  const gens = cachePrime_();
  const builders = bootBuilders_();
  const names = Object.keys(builders);
  const cache = CacheService.getScriptCache();
  const today = todayYmd_();
  names.forEach(function (part) {
    const started = Date.now();
    let text = '';
    try { text = JSON.stringify(builders[part]()); } catch (e) { lines.push(part + '：作れません（' + e + '）'); return; }
    const ms = Date.now() - started;
    const n = Math.ceil(text.length / CACHE_CHUNK_CHARS) || 1;
    let inCache = '不明';
    if (gens) {
      try {
        const extra = ALERT_PART_NAMES.indexOf(part) !== -1 ? today : undefined;
        const keys = [];
        for (let i = 0; i < CACHE_MAX_CHUNKS; i++) keys.push(cachePartKey_(part, i));
        // 調べるために作り直したので、この表示の前の状態を見る（作る前に読んだものではない点に注意）
        inCache = cacheJoin_(cache.getAll(keys) || {}, part, cachePartSig_(part, gens, extra)) !== undefined ? 'あり' : 'なし';
      } catch (e) { inCache = '読めません'; }
    }
    lines.push(part + '：' + Math.round(text.length / 1000) + 'K文字・' + n + '個・作るのに' + ms + 'ms・控え' + inCache +
      (n > CACHE_MAX_CHUNKS ? '　★大きすぎて控えられません' : ''));
  });
  ui.alert('控えの状態（上限は1部品 ' + Math.round(CACHE_CHUNK_CHARS * CACHE_MAX_CHUNKS / 1000) + 'K文字）\n\n' + lines.join('\n'));
}
