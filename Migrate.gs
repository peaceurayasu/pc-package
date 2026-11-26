/**
 * Migrate.gs … 前のシステム（AppSheet で使っていた「Company」スプレッドシート）からの取り込み
 *
 * ・このファイルは、移行の時だけ使う。パッケージ本体には要らないので、移行が終わったら消してよい
 *   （消すと、スプレッドシートのメニュー「データ移行」も出なくなる）。
 * ・元のスプレッドシートは読むだけ。書き換えない。
 * ・元のIDをそのまま使う（会社ID→顧客ID、PC管理番号→機器ID、対応ID、ライセンスID…）。
 *   そのため、何回実行しても同じものを二重には入れない。まだ入っていない行だけを足す。
 *   AppSheet を使い続けながら、後でもう一度実行して差分を取り込むこともできる。
 * ・すでにこちらに入っている行は、書き換えない（こちらで直した内容を守る）。
 * ・列は、元のシートに合わせる。
 *     - 元にある列は、1つも落とさずに持ってくる（アプリが使わない列も、そのままの見出しで入れる）。
 *     - 並びも、元のシートの順にそろえる。元に無い列（地域・状態・登録日時など）は右端に置く。
 *     - 見出しの名前だけは、アプリが使う名前にする（会社ID→顧客ID、電話番号→電話 など。MIG_COLUMNS を見る）。
 *     - アプリが使わない列は、シートに入るだけで、画面には出ない。要らなければ、後で列ごと消してよい。
 *     - 前に取り込んだ行で、持ってきた列が空のところは、元の値で埋める（アプリが使う列は書き換えない）。
 *
 * メニュー（スプレッドシートを開き直すと「データ移行」が出る）
 *   1. 元のスプレッドシートを指定する
 *   2. 確認だけ（何件入るか・入れられないものは何か。シートは書き換えない）
 *   3. 顧客だけ取り込む
 *   4. 全部取り込む
 * 結果は「移行レポート」シートに出る。
 *
 * 取り込むもの（元のシート → こちらのシート）
 *   Company            → 顧客（＋保守実施日 → 保守実施）
 *   PClist             → 機器・機器診断（収集ツールの値）・認証情報（メールアドレスとパスワード）
 *   ActivityLog        → 対応履歴（PinnedActivity にあるものはピン留め）
 *   repairlist         → 修理案件
 *   license            → ライセンス・認証情報（ID・パスワード・シリアルキー）
 *   Licensemanagement  → ライセンス割当
 *   MaintenanceLog     → 保守実施
 *   StaffMemo          → 社内メモ
 *   Notice             → お知らせ
 *   RentalPCInventory  → レンタル機器、RentalLog → 貸出記録
 *   LayoutData         → レイアウト
 * 取り込まないシート
 *   Users（パスワードの方式が違う。スタッフは「設定」で足す）、AuditLog、AlertResolved、AlertNotified、
 *   RentalAlertNotified、Tips、WinUpdateFeed、CalendarSyncLog、menu1、menu2、explanation、
 *   Projects、Tasks、salessheet、Attachment、MaintenanceHistory
 * ファイルの列（Company の「レイアウト図・構成リスト・報告書・設置個所」、ActivityLog の「画像」、repairlist の「サイン・写真」）は、
 *   セルの文字（AppSheet のファイルの場所）だけを持ってくる。ファイルそのものは写さない。
 *
 * 公開関数（どれも最初に SpreadsheetApp.getUi() を呼ぶので、ウェブアプリ経由では動かない）
 *   migrateSetSource / migrateCheck / migrateCustomers / migrateAll
 */

const MIG_SOURCE_PROPERTY = 'MIGRATE_SOURCE_ID';
const MIG_REPORT_SHEET = '移行レポート';
// 住所から地域を決める（前のダッシュボードと同じ市町村の表）。どれにも当たらなければ空のまま
const MIG_REGIONS = [
  ['南部', ['那覇市', '糸満市', '豊見城市', '南城市', '八重瀬町', '与那原町', '南風原町', '西原町']],
  ['中部', ['浦添市', '宜野湾市', '沖縄市', 'うるま市', '北谷町', '嘉手納町', '読谷村', '北中城村', '中城村']],
  ['北部', ['名護市', '本部町', '恩納村', '今帰仁村', '大宜味村', '東村', '国頭村', '金武町', '宜野座', '伊江村']],
  ['宮古', ['宮古島市', '多良間村']],
  ['八重山', ['石垣市', '竹富町', '与那国町']]
];
const MIG_REGION_ORDER = ['北部', '中部', '南部', '宮古', '八重山'];
/**
 * こちらのシート ← 元のシート。rename は「元の見出し → こちらの見出し」（書いていない列は、同じ見出しのまま持ってくる）。
 * 持ってきた見出しが、アプリの決めた列（SCHEMA）に無ければ、「アプリが使わない列」として値をそのまま（文字で）入れる。
 */
const MIG_COLUMNS = [
  { sheet: SHEET_CUSTOMERS, idField: '顧客ID', source: 'Company', rename: { '会社ID': '顧客ID', '会社名': '顧客名', '電話番号': '電話', '担当者': '先方担当者' } },
  { sheet: SHEET_DEVICES, idField: '機器ID', source: 'PClist', rename: { 'PC管理番号': '機器ID', '会社名': '顧客ID', '利用者(ふりがな)': 'ふりがな', '購入会社': '購入元' } },
  { sheet: SHEET_ACTIVITIES, idField: '対応ID', source: 'ActivityLog', rename: { '会社名': '顧客ID', '担当者': '先方担当者', '受付担当者': '受付スタッフ' } },
  { sheet: SHEET_REPAIRS, idField: '修理ID', source: 'repairlist', rename: { '対応ID': '修理ID', '会社名': '顧客ID', '担当者': '先方担当者', 'タイトル': '件名' } },
  { sheet: SHEET_LICENSES, idField: 'ライセンスID', source: 'license', rename: { '会社ID': '顧客ID', 'ソフト名': '製品名', '数': '数量' } },
  { sheet: SHEET_ALLOCATIONS, idField: '割当ID', source: 'Licensemanagement', rename: { 'PC管理番号': '機器ID' } },
  { sheet: SHEET_MAINT, idField: '実施ID', source: 'MaintenanceLog', rename: { 'ID': '実施ID', '会社名': '顧客ID' } },
  { sheet: SHEET_MEMOS, idField: 'メモID', source: 'StaffMemo', rename: { '会社ID': '顧客ID' } },
  { sheet: SHEET_NOTICES, idField: 'お知らせID', source: 'Notice', rename: { '会社ID': '顧客ID' } },
  { sheet: SHEET_RENTALS, idField: 'レンタルID', source: 'RentalPCInventory', rename: { 'PC管理番号': 'レンタルID', 'シリアル番号': 'シリアル' } },
  { sheet: SHEET_LOANS, idField: '貸出ID', source: 'RentalLog', rename: { 'PC管理番号': 'レンタルID', '担当者': '担当スタッフ' } },
  { sheet: SHEET_LAYOUTS, idField: 'レイアウトID', source: 'LayoutData', rename: { '会社ID': '顧客ID', '図形要素情報(JSON)': '図形' } }
];

/** Setup.gs の onOpen から呼ばれる（このファイルがある時だけ、メニューが出る） */
function migrationMenu_(ui) {
  ui.createMenu('データ移行')
    .addItem('1. 元のスプレッドシートを指定する', 'migrateSetSource')
    .addItem('2. 確認だけ（何件入るかを見る。書き換えない）', 'migrateCheck')
    .addSeparator()
    .addItem('3. 顧客だけ取り込む', 'migrateCustomers')
    .addItem('4. 全部取り込む', 'migrateAll')
    .addToUi();
}

// ---------------------------------------------------------------------------
// 公開関数（メニューから）
// ---------------------------------------------------------------------------
function migrateSetSource() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('元のスプレッドシート', '前のシステムのスプレッドシート（Company）のURLかIDを入れてください。', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const id = migSourceIdFrom_(res.getResponseText());
  if (!id) { ui.alert('URLかIDの形が正しくありません。'); return; }
  if (id === getSs_().getId()) { ui.alert('それは、このスプレッドシート自身です。前のシステムのほうを指定してください。'); return; }
  let src;
  try { src = SpreadsheetApp.openById(id); } catch (e) { ui.alert('開けませんでした。URLが正しいか、このアカウントで開けるスプレッドシートかを確かめてください。'); return; }
  if (!src.getSheetByName('Company')) { ui.alert('そのスプレッドシートには「Company」シートがありません。'); return; }
  PropertiesService.getScriptProperties().setProperty(MIG_SOURCE_PROPERTY, id);
  ui.alert('指定しました：' + src.getName() + '\n次に「2. 確認だけ」を実行してください。');
}

function migrateCheck() {
  const ui = SpreadsheetApp.getUi();
  const src = migOpenSource_(ui);
  if (!src) return;
  const plan = withLock_(function () { return migPlan_(src, true); });
  migWriteReport_(plan, '確認だけ（まだ何も入れていません）');
  ui.alert('確認の結果', migSummary_(plan, false) + '\n\n詳しくは「' + MIG_REPORT_SHEET + '」シートを見てください。まだ何も入れていません。', ui.ButtonSet.OK);
}

function migrateCustomers() {
  migRun_(false);
}

function migrateAll() {
  migRun_(true);
}

function migRun_(everything) {
  const ui = SpreadsheetApp.getUi();
  const src = migOpenSource_(ui);
  if (!src) return;
  const what = everything ? '顧客・機器・対応履歴・修理・ライセンスなど全部' : '顧客だけ';
  const answer = ui.alert('データ移行', '前のシステムから、' + what + 'を取り込みます。\nすでに入っている行は書き換えず、まだ無い行だけを足します。よいですか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  const plan = withLock_(function () {
    const p = migPlan_(src, everything);
    migApply_(p);
    return p;
  });
  const after = migAlertNote_();
  if (after) plan.notes.unshift(['要対応', '注意', '', after]);
  migWriteReport_(plan, '取り込みました');
  ui.alert('取り込みました', migSummary_(plan, true) + (after ? '\n\n' + after : '') + '\n\n詳しくは「' + MIG_REPORT_SHEET + '」シートを見てください。', ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// 元のスプレッドシートを読む
// ---------------------------------------------------------------------------
function migSourceIdFrom_(text) {
  const s = String(text || '').trim();
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}

function migOpenSource_(ui) {
  if (!isSetupDone_()) { ui.alert('先に、メニュー「PC管理」→「初期設定」を実行してください。'); return null; }
  const id = PropertiesService.getScriptProperties().getProperty(MIG_SOURCE_PROPERTY);
  if (!id) { ui.alert('先に「1. 元のスプレッドシートを指定する」を実行してください。'); return null; }
  try {
    const src = SpreadsheetApp.openById(id);
    if (!src.getSheetByName('Company')) { ui.alert('元のスプレッドシートに「Company」シートがありません。指定し直してください。'); return null; }
    return src;
  } catch (e) {
    ui.alert('元のスプレッドシートを開けませんでした。「1. 元のスプレッドシートを指定する」をやり直してください。');
    return null;
  }
}

/** 元のシートを、見出しをキーにした行の配列で読む。シートが無ければ空 */
function migRead_(src, name) {
  const sheet = src.getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const headers = (values[0] || []).map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _row: i + 1 };
    let empty = true;
    headers.forEach(function (h, j) {
      if (!h) return;
      obj[h] = values[i][j];
      if (values[i][j] !== '' && values[i][j] !== null) empty = false;
    });
    if (!empty) rows.push(obj);
  }
  return rows;
}

/** 元のシートの見出し（左から。空の見出しは除く） */
function migHeaders_(src, name) {
  const sheet = src.getSheetByName(name);
  if (!sheet || !sheet.getLastColumn()) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); }).filter(function (h) { return h; });
}

/**
 * 1つのシートの、列の並べ方を決める。
 * @return {{sheet, idField, desired:Array<string>, extras:Array<Array<string>>, added:Array<string>}}
 *   desired … そろえた後の見出しの並び（元の順 → こちらにしか無い列）
 *   extras  … アプリが使わない列 [元の見出し, こちらの見出し]
 *   added   … 今のシートに無くて、足すことになる見出し
 */
function migColumnPlan_(src, def) {
  const types = typeMap_(def.sheet);
  const current = readTable_(def.sheet).headers.filter(function (h) { return h; });
  const desired = [];
  const extras = [];
  migHeaders_(src, def.source).forEach(function (h) {
    const to = def.rename[h] || h;
    if (desired.indexOf(to) !== -1) return;          // 同じ見出しが2つある時は、左の1つだけ
    desired.push(to);
    if (types[to] === undefined) extras.push([h, to]);
  });
  current.forEach(function (h) { if (desired.indexOf(h) === -1) desired.push(h); });
  return { sheet: def.sheet, idField: def.idField, source: def.source, desired: desired, extras: extras, added: desired.filter(function (h) { return current.indexOf(h) === -1; }) };
}

/** アプリが使わない列に入れる値。そのままの見た目に近い文字にする（日付は yyyy-MM-dd、時刻があれば HH:mm も） */
function migRaw_(v) {
  if (v === null || v === undefined) return '';
  if (migIsDate_(v)) {
    const hm = Utilities.formatDate(v, scriptTz_(), 'HH:mm:ss');
    return Utilities.formatDate(v, scriptTz_(), hm === '00:00:00' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
  }
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return cleanText_(v, 45000);
}

// ---------------------------------------------------------------------------
// 値をそろえる
// ---------------------------------------------------------------------------
function migIsDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

/** 文字にする。IDが数字のセルに入っていても '12' のように読む（'12.0' にしない） */
function migText_(v, max) {
  if (v === null || v === undefined) return '';
  if (migIsDate_(v)) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd');
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return cleanText_(v, max || 0);
}

function migLine_(v, max) {
  return migText_(v, max).replace(/\n/g, ' ');
}

/** 'yyyy-MM-dd'。読めなければ '' */
function migYmd_(v) {
  if (migIsDate_(v)) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd');
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  return parseYmd_(s.split(/[ T]/)[0]) || '';
}

/** 'yyyy-MM-dd HH:mm'。読めなければ '' */
function migYmdHm_(v) {
  if (migIsDate_(v)) return Utilities.formatDate(v, scriptTz_(), 'yyyy-MM-dd HH:mm');
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  return parseYmdHm_(s) || '';
}

/** 「✅完了」「🔵保留中」のような頭の記号を取る */
function migStatus_(v) {
  return migLine_(v).replace(/^[^0-9A-Za-z぀-ヿ一-鿿]+/, '').trim();
}

function migRegion_(address) {
  const s = String(address || '');
  for (let i = 0; i < MIG_REGIONS.length; i++) {
    for (let j = 0; j < MIG_REGIONS[i][1].length; j++) {
      if (s.indexOf(MIG_REGIONS[i][1][j]) !== -1) return MIG_REGIONS[i][0];
    }
  }
  return '';
}

/** 顧客名を見比べるための形（空白を取る） */
function migNameKey_(v) {
  return String(v || '').replace(/[\s　]/g, '');
}

function migYesNo_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'はい' || s === '1' || v === true ? YES : NO;
}

// ---------------------------------------------------------------------------
// 何を入れるかを決める（ここでは書かない）
// ---------------------------------------------------------------------------
/**
 * @param {Spreadsheet} src 元のスプレッドシート
 * @param {boolean} everything false なら顧客だけ
 * @return {{adds:Object, options:Object, layouts:Array, lines:Array, notes:Array, everything:boolean}}
 *   adds   … {こちらのシート名: [足す行]}
 *   lines  … レポートのまとめ [区分, 元の件数, 入れる, すでにある, 入れない]
 *   notes  … レポートの明細 [区分, 種類（入れない／注意／入れないもの）, ID, 説明]
 */
function migPlan_(src, everything) {
  const now = nowStamp_();
  const plan = { adds: {}, options: {}, layouts: [], lines: [], notes: [], columns: [], fill: {}, fillCells: 0, everything: !!everything, sourceName: src.getName() };
  // 列の並べ方（顧客だけの時は、顧客のシートだけ）
  const columnOf = {};
  MIG_COLUMNS.forEach(function (def) {
    if (!everything && def.sheet !== SHEET_CUSTOMERS) return;
    if (!src.getSheetByName(def.source)) return;
    const c = migColumnPlan_(src, def);
    columnOf[def.sheet] = c;
    plan.columns.push(c);
    plan.fill[def.sheet] = {};
  });
  /**
   * 元の行 r から、アプリが使わない列の値を取り出す {こちらの見出し: 値}。
   * id を渡すと、「すでに入っている行の、空のところを埋める」ための控えにも残す。
   */
  const extra = function (sheetName, id, r) {
    const c = columnOf[sheetName];
    const out = {};
    if (!c) return out;
    c.extras.forEach(function (x) { out[x[1]] = migRaw_(r[x[0]]); });
    if (id) plan.fill[sheetName][id] = out;
    return out;
  };
  const stamp = function (rec) { rec['登録日時'] = now; rec['更新日時'] = now; return rec; };
  const note = function (area, kind, id, text) { plan.notes.push([area, kind, id, text]); };
  const have = function (sheetName, idField) {
    const set = {};
    readTable_(sheetName).rows.forEach(function (r) { set[String(r[idField])] = true; });
    return set;
  };
  const optionsNow = getOptions_();
  const wantOption = function (category, value) {
    if (!value) return;
    const known = (optionsNow[category] || []).some(function (o) { return o.value === value; });
    if (known) return;
    const list = plan.options[category] = plan.options[category] || [];
    if (list.indexOf(value) === -1) list.push(value);
  };
  /** 1つの区分を数えながら、足す行をためる */
  const section = function (area, sheetName, total) {
    const s = { area: area, total: total, add: 0, exists: 0, skip: 0 };
    plan.lines.push(s);
    plan.adds[sheetName] = plan.adds[sheetName] || [];
    s.push = function (rec) { plan.adds[sheetName].push(rec); s.add++; };
    s.bad = function (id, why) { s.skip++; note(area, '入れない', id, why); };
    return s;
  };

  // ---- 顧客 ← Company
  const companies = migRead_(src, 'Company');
  const custHave = have(SHEET_CUSTOMERS, '顧客ID');
  const custAll = {};                       // 元にある顧客ID → {name, contract}（他のシートの突き合わせ用）
  const custNames = {};
  const sCust = section('顧客', SHEET_CUSTOMERS, companies.length);
  const dupName = {};
  companies.forEach(function (r) {
    const id = migLine_(r['会社ID'], 40);
    const name = migLine_(r['会社名'], 100);
    if (!id) { sCust.bad('（' + r._row + '行め）', '会社IDが空' + (name ? '：' + name : '')); return; }
    if (!name) { sCust.bad(id, '会社名が空'); return; }
    if (custAll[id]) { sCust.bad(id, '会社IDが重なっている（2つめ以降は入れない）：' + name); return; }
    const contract = /定期/.test(String(r['保守契約'] || '')) ? '定期保守' : /スポット/.test(String(r['保守契約'] || '')) ? 'スポット保守' : 'なし';
    custAll[id] = { name: name, contract: contract };
    const key = migNameKey_(name);
    if (custNames[key]) dupName[key] = (dupName[key] || [custNames[key]]).concat([id]); else custNames[key] = id;
    const exCust = extra(SHEET_CUSTOMERS, id, r);
    if (custHave[id]) { sCust.exists++; return; }
    const region = migRegion_(r['住所']);
    if (region) wantOption('地域', region);
    sCust.push(stamp(Object.assign(exCust, {
      '顧客ID': id, '顧客名': name, 'ふりがな': migLine_(r['ふりがな'], 100), '郵便番号': migLine_(r['郵便番号'], 10),
      '住所': migLine_(r['住所'], 200), '地域': region, '電話': migLine_(r['電話番号'], 40), 'メール': migLine_(r['メール'], 120),
      '先方担当者': migLine_(r['担当者'], 60), '保守契約': contract, '状態': '有効', 'ポータル公開': NO, 'ポータル表示': PORTAL_TABS_DEFAULT,
      '備考': migText_(r['備考'], 2000)
    })));
  });
  Object.keys(dupName).forEach(function (key) {
    note('顧客', '注意', dupName[key].join('、'), '同じ名前の顧客が' + dupName[key].length + '件ある（どちらも入れる）：' + custAll[dupName[key][0]].name);
  });
  // 地域の選択肢は、北部→中部→南部…の順で足す
  if (plan.options['地域']) plan.options['地域'].sort(function (a, b) { return MIG_REGION_ORDER.indexOf(a) - MIG_REGION_ORDER.indexOf(b); });
  const fileCols = ['レイアウト図', '構成リスト', '報告書', '設置個所'].map(function (c) {
    return [c, companies.filter(function (r) { return String(r[c] === null || r[c] === undefined ? '' : r[c]).trim() !== ''; }).length];
  }).filter(function (x) { return x[1]; });
  if (fileCols.length) {
    note('顧客', '注意', '', 'AppSheet のファイルの列（' + fileCols.map(function (x) { return x[0] + ' ' + x[1] + '件'; }).join('、') + '）は、セルの文字（ファイルの場所）だけを持ってくる。ファイルそのものは写さない。要るものは、顧客の「添付」に入れ直す');
  }
  if (!everything) {
    plan.columns.forEach(function (c) { plan.fillCells += migFill_(c, plan.fill[c.sheet], false); });
    return plan;
  }

  const custOk = function (id) { return !!custAll[id]; };

  // ---- 機器・機器診断・認証情報 ← PClist
  const pcs = migRead_(src, 'PClist');
  const devHave = have(SHEET_DEVICES, '機器ID');
  const diagHave = have(SHEET_DIAGNOSTICS, '機器ID');
  const credHave = have(SHEET_CREDENTIALS, '認証ID');
  const sDev = section('機器', SHEET_DEVICES, pcs.length);
  const sDiag = section('機器診断（収集ツールの値）', SHEET_DIAGNOSTICS, 0);
  const sCred = section('認証情報（機器のメール）', SHEET_CREDENTIALS, 0);
  const devAll = {};                         // 機器ID → 顧客ID
  const serialIndex = {};                    // 顧客ID|シリアル → [機器ID]
  let junkSerial = 0;
  // 選択肢に当てはめるための今の値（＋これから足すぶん）
  const makerOptions = function () {
    return { 'メーカー': (optionsNow['メーカー'] || []).concat((plan.options['メーカー'] || []).map(function (v) { return { value: v, active: true }; })) };
  };
  pcs.forEach(function (r) {
    const id = migLine_(r['PC管理番号'], 40);
    const customerId = migLine_(r['会社名'], 40);          // 「会社名」列には会社IDが入っている
    if (!id) { sDev.bad('（' + r._row + '行め）', 'PC管理番号が空'); return; }
    if (devAll[id] !== undefined) { sDev.bad(id, 'PC管理番号が重なっている（2つめ以降は入れない）'); return; }
    if (!custOk(customerId)) { sDev.bad(id, '会社が見つからない：' + (customerId || '（空）')); return; }
    devAll[id] = customerId;
    let serial = migLine_(r['シリアル'], 60);
    if (serial && isJunkSerial_(serial)) { serial = ''; junkSerial++; }
    if (serial) {
      const key = customerId + '|' + serial.toLowerCase();
      (serialIndex[key] = serialIndex[key] || []).push(id);
    }
    const computerName = migLine_(r['コンピューター名'], 60);
    // 機器診断（収集ツールが PClist に書いていた値）
    const hasDiag = ['コンピューター名', 'IPアドレス', 'OS', 'CPU', 'メモリ', 'SSD/HDD', 'ツールバージョン'].some(function (c) { return migText_(r[c]) !== ''; });
    if (hasDiag) {
      sDiag.total++;
      if (diagHave[id]) sDiag.exists++;
      else {
        const diag = { '機器ID': id, '受信日時': migYmdHm_(r['更新日']) };
        DIAG_MAP.forEach(function (m) {
          const from = m[0] === 'メーカー名' ? 'メーカー' : m[0];
          const raw = r[from];
          if (m[2] === 'number') {
            const n = parseInt(raw, 10);
            diag[m[1]] = isFinite(n) && n >= 0 && n < 1e9 ? n : '';
          } else if (m[2] === 'text') diag[m[1]] = migLine_(raw, m[3]);
          else diag[m[1]] = migText_(raw, m[3]);
        });
        diag['シリアル'] = serial;
        // 前のシートでは、ディスクの型番と健康状態が別の列だった
        const health = migText_(r['型番/健康状'], 2000);
        if (health) diag['ストレージ'] = [diag['ストレージ'], health].filter(function (x) { return x; }).join('\n');
        sDiag.push(diag);
      }
    }
    // 認証情報（その機器で使っているメールアドレスとパスワード）
    const mail = migLine_(r['メールアドレス'], 200);
    const pw = migLine_(r['パスワード'], 200);
    if (mail || pw) {
      sCred.total++;
      const credId = 'KD-' + id;
      if (credHave[credId]) sCred.exists++;
      else sCred.push(stamp({ '認証ID': credId, '顧客ID': customerId, '対象区分': '機器', '対象ID': id, '名称': 'メール', 'ログインID': mail, 'パスワード': pw, 'シリアルキー': '', '備考': '' }));
    }
    const exDev = extra(SHEET_DEVICES, id, r);
    if (devHave[id]) { sDev.exists++; return; }
    const rawMaker = migLine_(r['メーカー'], 40);
    let maker = normalizeMaker_(rawMaker, makerOptions());
    if (!maker && rawMaker) { maker = rawMaker.replace(/,/g, ' '); wantOption('メーカー', maker); }
    let kind = migLine_(r['種類'], 40);
    if (kind === 'その他機器' || !kind) kind = 'その他';
    wantOption('機器種類', kind);
    const seller = migLine_(r['購入会社'], 40).replace(/･/g, '・').replace(/,/g, ' ');
    wantOption('購入元', seller);
    let state = migLine_(r['状況'], 20);
    if (DEVICE_STATES.indexOf(state) === -1) state = '使用中';
    sDev.push(stamp(Object.assign(exDev, {
      '機器ID': id, '顧客ID': customerId, '状況': state, '種類': kind, '設置場所': migLine_(r['設置場所'], 100), '部署': migLine_(r['部署'], 60),
      '利用者': migLine_(r['利用者'], 60), 'ふりがな': migLine_(r['利用者(ふりがな)'], 60), 'メーカー': maker, '機種名': migLine_(r['機種名'], 100),
      'シリアル': serial, '購入日': migYmd_(r['購入日']), '購入元': seller, '保証期限': migYmd_(r['保証期限']), 'ESET': migYmd_(r['ESET']),
      '備考': migText_(r['備考'], 2000)
    })));
  });
  if (junkSerial) note('機器', '注意', '', 'シリアルが「未確認」などで機器を見分けられないもの ' + junkSerial + '台は、シリアルを空にして入れる');
  if (columnOf[SHEET_DEVICES] && columnOf[SHEET_DEVICES].extras.length) {
    note('機器', '注意', '', 'PClist の、収集ツールの列（コンピューター名・OS など）と「メールアドレス」「パスワード」は、機器のシートにもそのまま入る（画面には出ない）。' +
      '画面が使うのは、機器診断と認証情報のほう。機器のシートの列は、要らなければ消してよい');
  }
  Object.keys(serialIndex).filter(function (k) { return serialIndex[k].length > 1; }).forEach(function (k) {
    note('機器', '注意', serialIndex[k].join('、'), '同じ顧客に同じシリアルの機器が' + serialIndex[k].length + '台ある（収集ツールの受信は先に見つかった1台に入る）：' + k.split('|')[1]);
  });

  // ---- 対応履歴 ← ActivityLog（PinnedActivity にあるものはピン留め）
  const acts = migRead_(src, 'ActivityLog');
  const actHave = have(SHEET_ACTIVITIES, '対応ID');
  const pinned = {};
  migRead_(src, 'PinnedActivity').forEach(function (r) { pinned[migLine_(r['対応ID'])] = migLine_(r['固定理由'], 300) || ' '; });
  const sAct = section('対応履歴', SHEET_ACTIVITIES, acts.length);
  const actSeen = {};
  let actNoKind = 0, actImages = 0, actTimeOdd = 0;
  acts.forEach(function (r) {
    const id = migLine_(r['対応ID'], 40);
    const customerId = migLine_(r['会社名'], 40);
    if (!id) { sAct.bad('（' + r._row + '行め）', '対応IDが空'); return; }
    if (actSeen[id]) { sAct.bad(id, '対応IDが重なっている（2つめ以降は入れない）'); return; }
    actSeen[id] = true;
    if (!custOk(customerId)) { sAct.bad(id, '会社が見つからない：' + (customerId || '（空）')); return; }
    const start = migYmdHm_(r['開始日時']);
    const end = migYmdHm_(r['完了日時']);
    const date = migYmd_(r['受付日']) || start.slice(0, 10) || end.slice(0, 10);
    if (!date) { sAct.bad(id, '受付日が読めない'); return; }
    if (migText_(r['画像'])) actImages++;
    const exAct = extra(SHEET_ACTIVITIES, id, r);
    if (actHave[id]) { sAct.exists++; return; }
    let status = migStatus_(r['ステータス']);
    status = STATUS_RENAMES.activity[status] || status;     // 古い名前は新しい名前に（v0.52.0）
    if (ACTIVITY_STATUSES.indexOf(status) === -1) status = ACTIVITY_DONE;
    const kind = migLine_(r['対応種別'], 40).replace(/,/g, ' ');
    if (!kind) actNoKind++;
    if (start && end && end < start) actTimeOdd++;
    wantOption('対応種別', kind);
    const how = migLine_(r['受付方法'], 40).replace(/,/g, ' ');
    wantOption('受付方法', how);
    const incident = migLine_(r['インシデント種別'], 40).replace(/,/g, ' ');
    wantOption('インシデント種別', incident);
    const reason = (pinned[id] || '').trim();
    sAct.push(stamp(Object.assign(exAct, {
      '対応ID': id, '顧客ID': customerId, '機器ID': '', '受付日': date, '受付方法': how, '対応種別': kind, 'インシデント種別': incident,
      '先方担当者': migLine_(r['担当者'], 60), '受付スタッフ': migLine_(r['受付担当者'], 60), '開始日時': start, '完了日時': end,
      'ステータス': status, '内容': migText_(r['内容'], 4800) + (reason ? '\n【ピン留めの理由】' + reason : ''), 'ピン留め': pinned[id] ? YES : NO
    })));
  });
  if (actNoKind) note('対応履歴', '注意', '', '対応種別が空のもの ' + actNoKind + '件は、空のまま入れる（後で編集する時に種別を選ぶ）');
  if (actTimeOdd) note('対応履歴', '注意', '', '完了日時が開始日時より前のもの ' + actTimeOdd + '件は、そのまま入れる（対応時間には数えない。編集する時に直す）');
  if (actImages) note('対応履歴', '注意', '', '「画像」が付いた対応 ' + actImages + '件は、セルの文字（ファイルの場所）だけを持ってくる。画像そのものは写さない');

  // ---- 修理案件 ← repairlist
  const reps = migRead_(src, 'repairlist');
  const repHave = have(SHEET_REPAIRS, '修理ID');
  const sRep = section('修理案件', SHEET_REPAIRS, reps.length);
  const repSeen = {};
  let repLinked = 0, repMedia = 0, repNoDoneDate = 0;
  reps.forEach(function (r) {
    const id = migLine_(r['対応ID'], 40);
    const customerId = migLine_(r['会社名'], 40);
    if (!id) { sRep.bad('（' + r._row + '行め）', '対応IDが空'); return; }
    if (repSeen[id]) { sRep.bad(id, '対応IDが重なっている（2つめ以降は入れない）'); return; }
    repSeen[id] = true;
    if (!custOk(customerId)) { sRep.bad(id, '会社が見つからない：' + (customerId || '（空）')); return; }
    const date = migYmd_(r['受付日']);
    if (!date) { sRep.bad(id, '受付日が読めない'); return; }
    if (migText_(r['サイン']) || migText_(r['写真'])) repMedia++;
    const exRep = extra(SHEET_REPAIRS, id, r);
    if (repHave[id]) { sRep.exists++; return; }
    let status = migStatus_(r['ステータス']);
    status = STATUS_RENAMES.repair[status] || status;
    if (REPAIR_STATUSES.indexOf(status) === -1) status = migYmd_(r['完了日']) ? REPAIR_DONE : '受付';
    if (status === REPAIR_DONE && !migYmd_(r['完了日'])) repNoDoneDate++;
    const kind = migLine_(r['種別'], 40).replace(/,/g, ' ');
    wantOption('修理種別', kind);
    const serial = migLine_(r['シリアル'], 60);
    // 同じ顧客に、そのシリアルの機器が1台だけあれば、その機器につなぐ
    const hit = serial ? (serialIndex[customerId + '|' + serial.toLowerCase()] || []) : [];
    if (hit.length === 1) repLinked++;
    sRep.push(stamp(Object.assign(exRep, {
      '修理ID': id, '顧客ID': customerId, '機器ID': hit.length === 1 ? hit[0] : '', '元の対応ID': '', '受付日': date, '完了日': migYmd_(r['完了日']),
      'ステータス': status, '種別': kind, '預かり品': migLine_(r['預かり品'], 200).split(/\s*[,、]\s*/).filter(function (x) { return x; }).join('、'),
      '型番': migLine_(r['型番'], 100), 'シリアル': serial, '先方担当者': migLine_(r['担当者'], 60), '担当スタッフ': '',
      '件名': migLine_(r['タイトル'], 100) || '（件名なし）', '内容': migText_(r['内容'], 5000)
    })));
  });
  if (sRep.add) note('修理案件', '注意', '', 'シリアルから機器につなげたもの ' + repLinked + '件（他は、機器を選ばないまま入れる）');
  if (repNoDoneDate) note('修理案件', '注意', '', '完了になっているが完了日が空のもの ' + repNoDoneDate + '件は、完了日を空のまま入れる（「この期間に完了」には数えない。後で編集して保存すると、その日が完了日に入る）');
  if (repMedia) note('修理案件', '注意', '', 'サイン・写真が付いた修理 ' + repMedia + '件は、セルの文字（ファイルの場所）だけを持ってくる。画像そのものは写さない');

  // ---- ライセンス・認証情報 ← license
  const lics = migRead_(src, 'license');
  const licHave = have(SHEET_LICENSES, 'ライセンスID');
  const sLic = section('ライセンス', SHEET_LICENSES, lics.length);
  const sLicCred = section('認証情報（ライセンスのID・キー）', SHEET_CREDENTIALS, 0);
  const licAll = {};                          // ライセンスID → 顧客ID
  lics.forEach(function (r) {
    const id = migLine_(r['ライセンスID'], 40);
    const customerId = migLine_(r['会社ID'], 40);
    const name = migLine_(r['ソフト名'], 100);
    if (!id) { sLic.bad('（' + r._row + '行め）', 'ライセンスIDが空'); return; }
    if (licAll[id] !== undefined) { sLic.bad(id, 'ライセンスIDが重なっている（2つめ以降は入れない）'); return; }
    if (!custOk(customerId)) { sLic.bad(id, '会社が見つからない：' + (customerId || '（空）')); return; }
    if (!name) { sLic.bad(id, 'ソフト名が空'); return; }
    licAll[id] = customerId;
    const loginId = migLine_(r['ID'], 200), pw = migLine_(r['パスワード'], 200), key = migLine_(r['シリアルキー'], 200);
    if (loginId || pw || key) {
      sLicCred.total++;
      const credId = 'KL-' + id;
      if (credHave[credId]) sLicCred.exists++;
      else sLicCred.push(stamp({ '認証ID': credId, '顧客ID': customerId, '対象区分': 'ライセンス', '対象ID': id, '名称': name, 'ログインID': loginId, 'パスワード': pw, 'シリアルキー': key, '備考': '' }));
    }
    const exLic = extra(SHEET_LICENSES, id, r);
    if (licHave[id]) { sLic.exists++; return; }
    const qty = Number(r['数']);
    sLic.push(stamp(Object.assign(exLic, {
      'ライセンスID': id, '顧客ID': customerId, '製品名': name, '契約期間': '', '数量': isFinite(qty) && qty > 0 && String(r['数']).trim() !== '' ? Math.round(qty) : '',
      '有効期限': migYmd_(r['有効期限']), '備考': migText_(r['備考'], 2000)
    })));
  });
  if (columnOf[SHEET_LICENSES] && columnOf[SHEET_LICENSES].extras.length) {
    note('ライセンス', '注意', '', 'license の「ID」「パスワード」「シリアルキー」は、ライセンスのシートにもそのまま入る（画面には出ない）。画面が使うのは、認証情報のほう。ライセンスのシートの列は、要らなければ消してよい');
  }

  // ---- ライセンス割当 ← Licensemanagement
  const allocs = migRead_(src, 'Licensemanagement');
  const allocHave = have(SHEET_ALLOCATIONS, '割当ID');
  const pairHave = {};
  readTable_(SHEET_ALLOCATIONS).rows.forEach(function (r) { pairHave[r['ライセンスID'] + '|' + r['機器ID']] = true; });
  const sAlloc = section('ライセンス割当', SHEET_ALLOCATIONS, allocs.length);
  allocs.forEach(function (r) {
    const id = migLine_(r['割当ID'], 40) || ('LA-' + r._row);
    const licId = migLine_(r['ライセンスID'], 40), devId = migLine_(r['PC管理番号'], 40);
    if (licAll[licId] === undefined) { sAlloc.bad(id, 'ライセンスが見つからない：' + (licId || '（空）')); return; }
    if (devAll[devId] === undefined) { sAlloc.bad(id, '機器が見つからない：' + (devId || '（空）')); return; }
    if (licAll[licId] !== devAll[devId]) { sAlloc.bad(id, 'ライセンスと機器の顧客がちがう（' + licId + ' と ' + devId + '）'); return; }
    const exAlloc = extra(SHEET_ALLOCATIONS, allocHave[id] ? id : '', r);
    if (allocHave[id] || pairHave[licId + '|' + devId]) { sAlloc.exists++; return; }
    pairHave[licId + '|' + devId] = true;
    sAlloc.push(Object.assign(exAlloc, { '割当ID': id, 'ライセンスID': licId, '機器ID': devId, '割当日': migYmd_(r['割当日']) }));
  });

  // ---- 保守実施 ← MaintenanceLog と、Company の「保守実施日」
  const maintHave = have(SHEET_MAINT, '実施ID');
  const maintRows = [];
  migRead_(src, 'MaintenanceLog').forEach(function (r) {
    maintRows.push({ customerId: migLine_(r['会社名'], 40), date: migYmd_(r['実施日']), kind: migLine_(r['種別'], 40), from: 'MaintenanceLog' });
  });
  companies.forEach(function (r) {
    const id = migLine_(r['会社ID'], 40);
    if (migYmd_(r['保守実施日']) && custAll[id]) {
      maintRows.push({ customerId: id, date: migYmd_(r['保守実施日']), kind: custAll[id].contract === 'スポット保守' ? 'スポット保守' : MAINT_KIND_REGULAR, from: 'Company の保守実施日' });
    }
  });
  const sMaint = section('保守実施', SHEET_MAINT, maintRows.length);
  const maintSeen = {};
  maintRows.forEach(function (m) {
    if (!m.date) { sMaint.bad(m.customerId, '実施日が空（' + m.from + '）'); return; }
    if (!custOk(m.customerId)) { sMaint.bad(m.customerId || '（空）', '会社が見つからない（' + m.from + '）'); return; }
    // 同じ顧客・同じ日は1件にまとめる（IDも顧客と日付から作るので、何回実行しても増えない）
    const id = 'MG-' + m.customerId + '-' + m.date.replace(/-/g, '');
    if (maintSeen[id] || maintHave[id]) { sMaint.exists++; return; }
    maintSeen[id] = true;
    const kind = (m.kind || MAINT_KIND_REGULAR).replace(/,/g, ' ');
    wantOption('保守種別', kind);
    sMaint.push(stamp({ '実施ID': id, '顧客ID': m.customerId, '機器ID': '', '実施日': m.date, '種別': kind, '担当スタッフ': '', '内容': '保守を実施（前のシステムの記録）' }));   // 元のシートの名前は、お客様に出るところ（月次レポート）には書かない
  });

  // ---- 社内メモ ← StaffMemo
  const memos = migRead_(src, 'StaffMemo');
  const memoHave = have(SHEET_MEMOS, 'メモID');
  const sMemo = section('社内メモ', SHEET_MEMOS, memos.length);
  memos.forEach(function (r) {
    const id = migLine_(r['メモID'], 40) || ('NM-' + r._row);
    const body = migText_(r['本文'], 3000);
    if (!body) { sMemo.bad(id, '本文が空'); return; }
    const exMemo = extra(SHEET_MEMOS, id, r);
    if (memoHave[id]) { sMemo.exists++; return; }
    const customerId = migLine_(r['会社ID'], 40);
    const when = migYmdHm_(r['更新日時']) || now;
    sMemo.push(Object.assign(exMemo, { 'メモID': id, '顧客ID': custOk(customerId) ? customerId : '', '本文': body, '作成者': migLine_(r['作成者'], 60), 'ピン留め': migYesNo_(r['ピン留め']), '登録日時': when, '更新日時': when }));
  });

  // ---- お知らせ ← Notice
  const notices = migRead_(src, 'Notice');
  const noticeHave = have(SHEET_NOTICES, 'お知らせID');
  const sNotice = section('お知らせ', SHEET_NOTICES, notices.length);
  notices.forEach(function (r) {
    const id = migLine_(r['お知らせID'], 40) || ('IM-' + r._row);
    const body = migText_(r['本文'], 1000);
    if (!body) { sNotice.bad(id, '本文が空'); return; }
    const exNotice = extra(SHEET_NOTICES, id, r);
    if (noticeHave[id]) { sNotice.exists++; return; }
    const customerId = migLine_(r['会社ID'], 40);
    const when = migYmdHm_(r['更新日時']) || now;
    sNotice.push(Object.assign(exNotice, { 'お知らせID': id, '顧客ID': custOk(customerId) ? customerId : '', '本文': body, '重要度': migLine_(r['重要度']) === '重要' ? '重要' : '通常', '掲載期限': migYmd_(r['掲載期限']), '登録日時': when, '更新日時': when }));
  });

  // ---- レンタル機器 ← RentalPCInventory、貸出記録 ← RentalLog
  const rentals = migRead_(src, 'RentalPCInventory');
  const rentalHave = have(SHEET_RENTALS, 'レンタルID');
  const sRental = section('レンタル機器', SHEET_RENTALS, rentals.length);
  const rentalAll = {};
  rentals.forEach(function (r) {
    const id = migLine_(r['PC管理番号'], 40);
    if (!id) { sRental.bad('（' + r._row + '行め）', 'PC管理番号が空'); return; }
    if (rentalAll[id]) { sRental.bad(id, 'PC管理番号が重なっている（2つめ以降は入れない）'); return; }
    rentalAll[id] = true;
    const exRental = extra(SHEET_RENTALS, id, r);
    if (rentalHave[id]) { sRental.exists++; return; }
    let serial = migLine_(r['シリアル番号'], 60);
    if (serial && isJunkSerial_(serial)) serial = '';
    let state = migLine_(r['状態'], 20);
    if (RENTAL_STATES.indexOf(state) === -1) state = RENTAL_AVAILABLE;
    const kind = migLine_(r['種類'], 40);
    wantOption('機器種類', kind);
    const model = migLine_(r['機種名'], 100);
    sRental.push(stamp(Object.assign(exRental, { 'レンタルID': id, '名称': model || id, '種類': kind, 'メーカー': '', '機種名': model, 'シリアル': serial, '状態': state, '用途': migLine_(r['用途'], 60), '購入日': migYmd_(r['購入日']), '備考': migText_(r['備考'], 2000) })));
  });
  const loans = migRead_(src, 'RentalLog');
  const loanHave = have(SHEET_LOANS, '貸出ID');
  const sLoan = section('貸出記録', SHEET_LOANS, loans.length);
  loans.forEach(function (r) {
    const id = migLine_(r['貸出ID'], 40) || ('LN-' + r._row);
    const rentalId = migLine_(r['PC管理番号'], 40);
    if (!rentalAll[rentalId]) { sLoan.bad(id, 'レンタル機器が見つからない：' + (rentalId || '（空）')); return; }
    const date = migYmd_(r['貸出日']);
    if (!date) { sLoan.bad(id, '貸出日が読めない'); return; }
    const exLoan = extra(SHEET_LOANS, id, r);
    if (loanHave[id]) { sLoan.exists++; return; }
    const to = migLine_(r['貸出先'], 100);
    const customerId = custNames[migNameKey_(to)] || '';          // 貸出先の名前が顧客名と同じなら、その顧客につなぐ
    sLoan.push(stamp(Object.assign(exLoan, {
      '貸出ID': id, 'レンタルID': rentalId, '顧客ID': customerId, '貸出先': to, '貸出日': date, '返却予定日': migYmd_(r['返却予定日']), '返却日': migYmd_(r['返却日']),
      '担当スタッフ': migLine_(r['担当者'], 60), '修理ID': '', '備考': migText_(r['備考'], 2000)
    })));
  });

  // ---- レイアウト ← LayoutData（図形は、機器を入れた後で検査して入れる）
  const layouts = migRead_(src, 'LayoutData');
  const layoutHave = have(SHEET_LAYOUTS, 'レイアウトID');
  const sLayout = { area: 'レイアウト', total: layouts.length, add: 0, exists: 0, skip: 0 };
  plan.lines.push(sLayout);
  layouts.forEach(function (r) {
    const id = migLine_(r['レイアウトID'], 40);
    const customerId = migLine_(r['会社ID'], 40);
    const bad = function (why) { sLayout.skip++; note('レイアウト', '入れない', id || '（' + r._row + '行め）', why); };
    if (!id) { bad('レイアウトIDが空'); return; }
    if (!custOk(customerId)) { bad('会社が見つからない：' + (customerId || '（空）')); return; }
    let list = [];
    try {
      const parsed = JSON.parse(String(r['図形要素情報(JSON)'] || '[]'));
      list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.elements) ? parsed.elements : []);
    } catch (e) { bad('図形の中身が読めない'); return; }
    const imageId = migLine_(r['画像ファイルID'], 100);
    if (!list.length && !imageId) { bad('図形も画像も無い（空のレイアウト）'); return; }
    if (layoutHave[id]) { sLayout.exists++; return; }
    sLayout.add++;
    plan.layouts.push({ id: id, customerId: customerId, name: migLine_(r['名前'], 40) || 'レイアウト', imageId: imageId, elements: list.slice(0, LAYOUT_MAX_ELEMENTS).map(migLayoutElement_) });
  });

  // ---- すでに入っている行で、持ってきた列が空のところ（元の値で埋める）
  plan.columns.forEach(function (c) { plan.fillCells += migFill_(c, plan.fill[c.sheet], false); });

  // ---- 取り込まないシート
  [['Users', 'スタッフは「設定」で足す（パスワードの方式がちがうので、そのままは使えない）'],
    ['AuditLog', '変更履歴は取り込まない'], ['AlertResolved', '対応済みにしたアラートの記録は取り込まない（こちらで出たものを、あらためて対応済みにする）'],
    ['Projects', '営業の案件は対象外'], ['Tasks', '営業のタスクは対象外'], ['salessheet', '営業先の名簿は対象外'],
    ['Tips', '小ワザは対象外'], ['WinUpdateFeed', 'Windows Update の記事は対象外'], ['CalendarSyncLog', 'カレンダー連携の記録は対象外'],
    ['Attachment', '添付は、顧客の「添付」に入れ直す'], ['MaintenanceHistory', '機器ごとの保守履歴は対象外']
  ].forEach(function (x) {
    const n = migRead_(src, x[0]).length;
    if (n) note(x[0], '入れないもの', n + '件', x[1]);
  });
  return plan;
}

/** 前のダッシュボードの図形1つを、こちらの形に直す（決めた形にそろえるのは sanitizeLayoutElements_） */
function migLayoutElement_(el) {
  if (!el || typeof el !== 'object') return null;
  const out = {};
  Object.keys(el).forEach(function (k) { out[k] = el[k]; });
  const typeMap = { bookshelf: 'shelf', hub: 'rect', nas: 'rect', polyline: 'poly' };
  if (typeMap[out.type]) {
    if (!out.text && (out.type === 'hub' || out.type === 'nas')) out.text = out.type === 'hub' ? 'HUB' : 'NAS';
    out.type = typeMap[out.type];
  }
  if (out.type === 'pin' && out.deviceId === undefined) out.deviceId = out.pcId;
  if (out.rotation !== undefined && out.r === undefined) out.r = out.rotation;
  if (out.type === 'poly' && Array.isArray(out.points)) {
    out.points = out.points.map(function (p) { return Array.isArray(p) ? p : (p && typeof p === 'object' ? [p.x, p.y] : p); });
  }
  if (out.label !== undefined && out.text === undefined) out.text = out.label;
  return out;
}

// ---------------------------------------------------------------------------
// 書きこむ
// ---------------------------------------------------------------------------
/**
 * シートの列を、決めた並びにそろえる。無い列は足し、あとは列ごと動かすだけ（中身は書き換えない）。
 * アプリは列を見出しの名前で読むので、並びが変わっても動く。
 */
function migArrangeColumns_(c) {
  const sheet = readTable_(c.sheet).sheet;
  const read = function () {
    const last = sheet.getLastColumn();
    return last ? sheet.getRange(1, 1, 1, last).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  };
  let headers = read();
  const types = typeMap_(c.sheet);
  if (sheet.getLastRow() <= 1) {
    // まだ1行も入っていないシートは、見出しを書き直すだけで済む（列を1つずつ動かすより速い）
    if (c.desired.length > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), c.desired.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, 1, c.desired.length).setValues([c.desired]);
    const emptyRows = sheet.getMaxRows() - 1;
    if (emptyRows > 0) {
      sheet.getRange(2, 1, emptyRows, c.desired.length).setNumberFormats(
        new Array(emptyRows).fill(c.desired.map(function (h) { return numberFormat_(types[h] || 'text'); })));
    }
    forgetSheet_(c.sheet);
    formatSheet_(sheet, c.sheet);
    return;
  }
  // 足りない列を右端に足す（文字の書式にしておく。「001」や日付のような文字が、勝手に数や日付に変わらないように）
  const missing = c.desired.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    const start = headers.length + 1;
    const need = headers.length + missing.length;
    if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    const bodyRows = sheet.getMaxRows() - 1;
    if (bodyRows > 0) sheet.getRange(2, start, bodyRows, missing.length).setNumberFormat('@');
    headers = read();
  }
  // 左から順に、あるべき列を持ってくる
  c.desired.forEach(function (h, i) {
    const at = headers.indexOf(h);
    if (at === -1 || at === i) return;
    sheet.moveColumns(sheet.getRange(1, at + 1, 1, 1), i + 1);
    headers.splice(i, 0, headers.splice(at, 1)[0]);
  });
  forgetSheet_(c.sheet);
  if (missing.length) formatSheet_(sheet, c.sheet);
}

/**
 * すでに入っている行で、持ってきた列（アプリが使わない列）が空のところを、元の値で埋める。
 * アプリが使う列・すでに値が入っているセルは書き換えない。
 * @param {boolean} write false なら、埋めるセルの数を数えるだけ
 * @return {number} 埋めた（埋める）セルの数
 */
function migFill_(c, fill, write) {
  if (!c.extras.length || !fill) return 0;
  const sheet = readTable_(c.sheet).sheet;
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || !lastCol) return 0;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const idCol = headers.indexOf(c.idField);
  if (idCol === -1) return 0;
  const ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); });
  let count = 0;
  c.extras.forEach(function (x) {
    const col = headers.indexOf(x[1]);
    // まだ列が無いとき（確認だけの時）は、全部が空として数える
    const range = col === -1 ? null : sheet.getRange(2, col + 1, lastRow - 1, 1);
    const current = range ? range.getValues() : ids.map(function () { return ['']; });
    const hit = [];
    current.forEach(function (cell, i) {
      const want = fill[ids[i]] ? fill[ids[i]][x[1]] : '';
      if (cell[0] === '' && want !== '' && want !== undefined) hit.push([i, want]);
    });
    count += hit.length;
    if (!write || !hit.length || !range) return;
    // 列をまとめて書く（1セルずつ書くと遅い）。空だったセルだけを変え、他は読んだ値をそのまま戻す
    const formats = range.getNumberFormats();
    const next = current.map(function (cell) { return [typeof cell[0] === 'string' ? toCell_('text', cell[0]) : cell[0]]; });
    hit.forEach(function (h) { formats[h[0]] = ['@']; next[h[0]] = [toCell_('text', h[1])]; });
    range.setNumberFormats(formats);
    range.setValues(next);
  });
  if (write && count) forgetSheet_(c.sheet);
  return count;
}

function migApply_(plan) {
  // 列を、元のシートの並びにそろえる（足りない列は足す）
  plan.columns.forEach(migArrangeColumns_);

  // 選択肢（元のデータにあって、こちらに無い値）
  const optionRows = [];
  Object.keys(plan.options).forEach(function (category) {
    if (OPTION_CATEGORIES.indexOf(category) === -1) return;
    let order = readTable_(SHEET_OPTIONS).rows.filter(function (r) { return r['区分'] === category; })
      .reduce(function (m, r) { return Math.max(m, Number(r['表示順']) || 0); }, 0);
    plan.options[category].forEach(function (value) {
      order += 10;
      optionRows.push({ '区分': category, '値': String(value).slice(0, 40), '表示順': order, '有効': YES });
    });
  });
  appendRecords_(SHEET_OPTIONS, optionRows);

  // 顧客 → 機器 → … の順（あとのものが、前のものを指すため）
  [SHEET_CUSTOMERS, SHEET_DEVICES, SHEET_DIAGNOSTICS, SHEET_CREDENTIALS, SHEET_ACTIVITIES, SHEET_REPAIRS, SHEET_LICENSES,
    SHEET_ALLOCATIONS, SHEET_MAINT, SHEET_MEMOS, SHEET_NOTICES, SHEET_RENTALS, SHEET_LOANS].forEach(function (sheetName) {
    appendRecords_(sheetName, plan.adds[sheetName] || []);
  });

  // レイアウト（機器が入った後で、図形を検査する。他の顧客の機器を指すピン・知らない図形は落ちる）
  const now = nowStamp_();
  const layoutRows = [];
  plan.layouts.forEach(function (l) {
    const elements = sanitizeLayoutElements_(l.elements.filter(function (x) { return x; }), l.customerId);
    const dropped = l.elements.length - elements.length;
    if (dropped) plan.notes.push(['レイアウト', '注意', l.id, '図形 ' + l.elements.length + '個のうち ' + dropped + '個は入れられなかった（機器が見つからないピン・知らない種類）']);
    let imageId = '';
    if (l.imageId) {
      try {
        imageId = DriveApp.getFileById(l.imageId).makeCopy('layout_' + l.id, filesFolder_()).getId();
      } catch (e) {
        plan.notes.push(['レイアウト', '注意', l.id, '背景の画像を写せなかった（画像は入れ直す）']);
      }
    }
    layoutRows.push({ 'レイアウトID': l.id, '顧客ID': l.customerId, '名前': l.name, '背景色': '#ffffff', '画像ファイルID': imageId, '図形': JSON.stringify(elements), '登録日時': now, '更新日時': now });
  });
  appendRecords_(SHEET_LAYOUTS, layoutRows);

  // すでに入っていた行の、持ってきた列が空のところを埋める（今足した行は、もう入っている）
  plan.fillCells = 0;
  plan.columns.forEach(function (c) { plan.fillCells += migFill_(c, plan.fill[c.sheet], true); });

  const total = plan.lines.reduce(function (n, s) { return n + s.add; }, 0);
  logAudit_('データ移行', plan.sourceName, '', plan.everything ? '全部' : '顧客だけ', '', total + '件を取り込み', 'データ移行');
}

/** 取り込んだ後に、要対応が何件出るか（多い時に、先に知らせる） */
function migAlertNote_() {
  let list;
  try { list = withLock_(function () { return alertsForClient_(); }); } catch (e) { return ''; }
  const open = list.filter(function (a) { return !a.resolved; });
  if (!open.length) return '';
  const counts = {};
  open.forEach(function (a) { counts[a.label] = (counts[a.label] || 0) + 1; });
  return '今、要対応が ' + open.length + '件 出ています（' + Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; }).join('、') + '）。' +
    '毎朝の通知を入れてあると、次の朝にまとめて届きます。多すぎる時は、管理画面の「設定」→「要対応と通知」で日数やしきい値を変えてください（0 にすると、その種類は出ません）。';
}

function migSummary_(plan, done) {
  const word = done ? '入れた' : '入れる';
  const lines = plan.lines.filter(function (s) { return s.total || s.add; }).map(function (s) {
    return s.area + '：' + word + ' ' + s.add + '件' + (s.exists ? '、すでにある ' + s.exists + '件' : '') + (s.skip ? '、入れない ' + s.skip + '件' : '');
  });
  const added = plan.columns.reduce(function (n, c) { return n + c.added.length; }, 0);
  if (added) lines.push('列：元のシートに合わせて ' + added + '列を' + (done ? '足した' : '足す') + '（並びも元の順にそろえる）');
  if (plan.fillCells) lines.push('すでにある行：持ってきた列の空のところ ' + plan.fillCells + 'か所を' + (done ? '埋めた' : '埋める'));
  if (!plan.everything) lines.push('（顧客だけ。機器・対応履歴などは「4. 全部取り込む」で入ります）');
  return lines.join('\n');
}

/** 結果を「移行レポート」シートに書く（毎回、書き直す） */
function migWriteReport_(plan, title) {
  const ss = getSs_();
  const sheet = ss.getSheetByName(MIG_REPORT_SHEET) || ss.insertSheet(MIG_REPORT_SHEET);
  sheet.clear();
  const rows = [['データ移行のレポート', title, nowStamp_(), '元：' + plan.sourceName, ''], ['', '', '', '', ''], ['区分', '元の件数', '入れる（入れた）', 'すでにある', '入れない']];
  plan.lines.forEach(function (s) { rows.push([s.area, s.total, s.add, s.exists, s.skip]); });
  const optionText = Object.keys(plan.options).map(function (c) { return c + '：' + plan.options[c].join('、'); });
  rows.push(['', '', '', '', '']);
  rows.push(['足す選択肢', optionText.length ? optionText.join(' ／ ') : '（なし）', '', '', '']);
  rows.push(['', '', '', '', '']);
  rows.push(['列（元のシートの並びにそろえる）', '足す列（アプリが使わない列。画面には出ない）', '', '', '']);
  plan.columns.forEach(function (c) {
    rows.push([c.sheet + ' ← ' + c.source, c.added.length ? c.added.join('、') : '（足す列はなし。並びだけそろえる）', '', '', '']);
  });
  rows.push(['すでにある行の、空のところを埋める', plan.fillCells + 'か所', '', '', '']);
  rows.push(['', '', '', '', '']);
  rows.push(['区分', '種類', 'ID', '説明', '']);
  if (!plan.notes.length) rows.push(['（入れないもの・注意は、ありません）', '', '', '', '']);
  plan.notes.forEach(function (n) { rows.push([n[0], n[1], n[2], n[3], '']); });
  // 文字として書く（「=」などで始まる値が数式にならないように）
  const safe = rows.map(function (r) { return r.map(function (v) { return typeof v === 'number' ? v : toCell_('text', String(v)); }); });
  const range = sheet.getRange(1, 1, safe.length, 5);
  range.setNumberFormats(safe.map(function (r) { return r.map(function (v) { return typeof v === 'number' ? '0' : '@'; }); }));
  range.setValues(safe);
}
