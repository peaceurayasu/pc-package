/**
 * Db.gs … スプレッドシートの読み書きの土台
 *
 * - 列は「見出しの名前」で引く。列を並べ替えても、お客さんが列を足しても壊れない
 * - 読み込みはシートごとに1回（getDataRange().getValues()）。1回の実行の中では使い回す
 * - 書き込みは必ず withLock_() の中で行う
 * - 末尾がアンダースコアの関数は、画面（google.script.run）からは呼べない
 */

let ss_ = null;
let tableCache_ = {};
let lockDepth_ = 0;          // withLock_ の中にいるか
let dirtySheets_ = {};       // この実行で書いたシート（サーバー側の控えを使えなくするために覚える）
let refMemo_ = {};           // この実行で読んだ「参照の控え」（スタッフ・設定・選択肢。v0.18.0）
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
  if (!names.length) return;
  // 書き込みがシートに届いてから、控えを使えなくする（順番が逆だと、古い中身が控えに入る）。
  // flush に失敗しても、控えは必ず使えなくする（書き込みが届いているかもしれないので）
  try { SpreadsheetApp.flush(); } catch (e) { console.warn('flush に失敗しました: ' + e); }
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

/** 書き込みの排他。中で読み直すので、ロック前に読んだ内容は使わないこと */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    throw appError_('busy', 'ほかの人の保存と重なりました。もう一度試してください。');
  }
  try {
    tableCache_ = {};
    refMemo_ = {};
    lockDepth_++;
    const result = fn();
    SpreadsheetApp.flush();
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

/** そのシートの行について覚えているものを忘れる（見出しは残す）。書いたあとに呼ぶ */
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
  // かたまりが多いと、読む回数のほうが高くつく。そのときは丸ごと読む
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

/** そのシートについて覚えているもの（中身・見出し）を忘れる。列を動かしたあとに呼ぶ */
function forgetSheet_(sheetName) {
  forgetRows_(sheetName);
  delete tableCache_[HEAD_KEY + sheetName];
}

/**
 * シートに書いた行を、読み戻したときと同じ形にする（書いたあとに表を読み直さないで、返事を作るため）。
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
 * 同じ実行の中で同じシートを何度も探すときは、3回めから表を丸ごと読む（そのほうが速い）。
 * @return {Object|null|undefined} 見つからなければ null、この方法が使えないときは undefined（ふつうに探す）
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
  if (!cell) return undefined;      // 見つからないときは、念のためふつうに探す（表示の違う値も拾うため）
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
  // 決めた列に無い列（足してある列）は、文字として入れる（「001」や日付のような文字が、勝手に数や日付に変わらないように）
  const formatRow = headers.map(function (h) { return numberFormat_(types[h] || 'text'); });
  const formats = objs.map(function () { return formatRow; });
  const start = sheet.getLastRow() + 1;
  const need = start + objs.length - 1;
  const max = sheet.getMaxRows();
  if (need > max) sheet.insertRowsAfter(max, need - max + 100);
  const range = sheet.getRange(start, 1, objs.length, n);
  range.setNumberFormats(formats);
  range.setValues(values);
  forgetRows_(sheetName);
  markDirty_(sheetName);
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
  if (tableCache_[sheetName]) {
    tableCache_[sheetName].rows.forEach(function (r) { see(r[idField]); });
  } else {
    // 表をまだ読んでいなければ、IDの列だけを読む（番号を決めるためだけに、表を丸ごと読まない）
    const head = tableHead_(sheetName);
    const col = head.headers.indexOf(idField);
    const lastRow = head.sheet.getLastRow();
    if (col !== -1 && lastRow >= 2) head.sheet.getRange(2, col + 1, lastRow - 1, 1).getValues().forEach(function (r) { see(r[0]); });
  }
  let s = String(max + 1);
  while (s.length < digits) s = '0' + s;
  return prefix + s;
}

// ---------------------------------------------------------------------------
// 設定・選択肢
// ---------------------------------------------------------------------------
/** 設定シートを {キー: 値} にする。シートに無いキーは既定値（v0.18.0：ふだんは控えから。ロックの中はシートから） */
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

/** 選択肢シートを {区分: [{value, active}]} にする（表示順で並べる。v0.18.0：ふだんは控えから） */
function getOptions_() {
  return refPart_('refOptions');
}
function readOptionsDirect_() {
  const out = {};
  OPTION_CATEGORIES.forEach(function (c) { out[c] = []; });
  const rows = readTable_(SHEET_OPTIONS).rows.slice();
  rows.sort(function (a, b) { return (Number(a['表示順']) || 0) - (Number(b['表示順']) || 0); });
  rows.forEach(function (r) {
    const cat = String(r['区分']).trim();
    const val = String(r['値']).trim();
    if (!out[cat] || !val) return;
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
