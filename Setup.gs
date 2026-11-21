/**
 * Setup.gs … スプレッドシートのメニュー、初期設定、サンプルデータ
 *
 * メニューから呼ぶ関数（onOpen / runSetup / insertSampleData / resetPasswordFromMenu、Alerts.gs の setupDailyTrigger / removeDailyTrigger）は、
 * 最初に SpreadsheetApp.getUi() を呼ぶ。ウェブアプリ経由で第三者が呼んでも、そこで止まって何も起きない。
 * 仮パスワードは画面のダイアログにだけ出し、戻り値では返さない。
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('PC管理')
    .addItem('初期設定（シートを作る・足りない列を足す）', 'runSetup')
    .addItem('サンプルデータを入れる', 'insertSampleData')
    .addSeparator()
    .addItem('毎朝の通知を設定（設定し直すときも）', 'setupDailyTrigger')
    .addItem('毎朝の通知をやめる', 'removeDailyTrigger')
    .addSeparator()
    .addItem('起こしておく（始業時間のあいだ30分ごと）を設定', 'setupWarmTrigger')
    .addItem('起こしておくのをやめる', 'removeWarmTrigger')
    .addSeparator()
    .addItem('スタッフのパスワードを再設定', 'resetPasswordFromMenu')
    .addToUi();  // 前のシステムからの取り込み（Migrate.gs を入れてあるときだけ、メニューを出す）
  if (typeof migrationMenu_ === 'function') migrationMenu_(ui);
}

// ---------------------------------------------------------------------------
// 初期設定
// ---------------------------------------------------------------------------
/** メニュー：初期設定。何度実行してもよい（既存のシート・列・値は消さない） */
function runSetup() {
  const ui = SpreadsheetApp.getUi();
  const report = withLock_(setupCore_);
  cacheBumpAll_();     // 列や設定が変わったかもしれないので、控えを全部作り直しにする
  const lines = ['初期設定が終わりました。（v' + APP_VERSION + '）', ''];
  lines.push(report.createdSheets.length ? '作ったシート：' + report.createdSheets.join('、') : '新しく作ったシートはありません。');
  if (report.addedColumns.length) lines.push('足した列：' + report.addedColumns.join('、'));
  if (report.adminPassword) {
    lines.push('', '最初の管理者を作りました。', 'スタッフID：admin', '仮パスワード：' + report.adminPassword,
      '', 'この画面を閉じると仮パスワードは二度と表示されません。ログインしたら、すぐに自分のパスワードに変えてください。');
  }
  if (report.warnings.length) lines.push('', '注意：', report.warnings.join('\n'));
  ui.alert(lines.join('\n'));
}

/** 初期設定の本体。withLock_ の中で呼ぶこと */
function setupCore_() {
  const ss = getSs_();
  const report = { createdSheets: [], addedColumns: [], adminPassword: '', warnings: [] };

  SHEET_ORDER.forEach(function (name) {
    const wanted = SCHEMA[name].map(function (c) { return c[0]; });
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name, ss.getNumSheets());
      // 新しいシートは26列。それより多い列のシート（機器診断 v0.25.0〜）は、先に列を足す
      if (wanted.length > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), wanted.length - sheet.getMaxColumns());
      sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
      // 作ったばかりの空のシートなので、使わない右側の列は落としておく
      const maxCols = sheet.getMaxColumns();
      if (maxCols > wanted.length) sheet.deleteColumns(wanted.length + 1, maxCols - wanted.length);
      report.createdSheets.push(name);
    } else {
      const lastCol = sheet.getLastColumn();
      const have = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
      const missing = wanted.filter(function (w) { return have.indexOf(w) === -1; });
      if (missing.length) {
        const need = lastCol + missing.length;
        if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
        sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
        missing.forEach(function (m) { report.addedColumns.push(name + '「' + m + '」'); });
      }
    }
    formatSheet_(sheet, name);
  });
  tableCache_ = {};

  // 設定：無いキーだけ足す
  const haveKeys = readTable_(SHEET_SETTINGS).rows.map(function (r) { return String(r['キー']).trim(); });
  appendRecords_(SHEET_SETTINGS, SETTING_DEFAULTS
    .filter(function (d) { return haveKeys.indexOf(d[0]) === -1; })
    .map(function (d) { return { 'キー': d[0], '値': d[1], '説明': d[2] }; }));

  // 選択肢：その区分に1件も無いときだけ、最初の値を入れる
  const optionRows = readTable_(SHEET_OPTIONS).rows;
  const seeds = [];
  OPTION_CATEGORIES.forEach(function (cat) {
    if (optionRows.some(function (r) { return String(r['区分']).trim() === cat; })) return;
    OPTION_DEFAULTS[cat].forEach(function (value, i) {
      seeds.push({ '区分': cat, '値': value, '表示順': (i + 1) * 10, '有効': YES });
    });
  });
  appendRecords_(SHEET_OPTIONS, seeds);

  // Tips：1件も無いときだけ、最初の文を入れる（そのあとは、配信フォルダーから足される。シートで直してもよい）
  if (!readTable_(SHEET_TIPS).rows.length) {
    const tipNow = nowStamp_();
    appendRecords_(SHEET_TIPS, WINDOWS_TIPS.map(function (t, i) {
      let num = String(i + 1);
      while (num.length < 4) num = '0' + num;
      return { 'TipID': 'T' + num, '見出し': t[0], '説明': t[1], '有効': YES, '登録日時': tipNow };
    }));
    CacheService.getScriptCache().remove(TIPS_CACHE_KEY);
  }

  // スタッフ：1人もいないときだけ、最初の管理者を作る
  if (!readTable_(SHEET_STAFF).rows.length) {
    const password = randomPassword_(10);
    const now = nowStamp_();
    appendRecord_(SHEET_STAFF, {
      'スタッフID': 'admin', '表示名': '管理者', 'パスワードハッシュ': makePasswordHash_(password),
      '権限': ROLE_ADMIN, '有効': YES, '登録日時': now, '更新日時': now
    });
    report.adminPassword = password;
  }

  if (ss.getSpreadsheetTimeZone() !== scriptTz_()) {
    report.warnings.push('スプレッドシートのタイムゾーン（' + ss.getSpreadsheetTimeZone() + '）と、スクリプトのタイムゾーン（' +
      scriptTz_() + '）が違います。日付がずれて見えることがあるので、同じにしてください。');
  }
  return report;
}

/** 見出しの見た目と、列ごとの書式（文字・日付・数値）をそろえる */
function formatSheet_(sheet, name) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const types = typeMap_(name);
  sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#e8eef5');
  sheet.setFrozenRows(1);
  const rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  if (headers.every(function (h) { return !!types[h]; })) {
    const formatRow = headers.map(function (h) { return numberFormat_(types[h]); });
    const formats = [];
    for (let i = 0; i < rows; i++) formats.push(formatRow);
    sheet.getRange(2, 1, rows, lastCol).setNumberFormats(formats);
  } else {
    // お客さんが足した列があるときは、その列の書式には触らない
    headers.forEach(function (h, j) {
      if (types[h]) sheet.getRange(2, j + 1, rows, 1).setNumberFormat(numberFormat_(types[h]));
    });
  }
}

// ---------------------------------------------------------------------------
// パスワードの再設定（ログインできなくなったとき用）
// ---------------------------------------------------------------------------
function resetPasswordFromMenu() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const res = ui.prompt('スタッフのパスワードを再設定', 'スタッフIDを入れてください（例：admin）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const id = normStaffId_(res.getResponseText());
  let password = '';
  withLock_(function () {
    const staff = findStaff_(id);
    if (!staff) return;
    password = randomPassword_(10);
    updateRecord_(SHEET_STAFF, staff._row, { 'パスワードハッシュ': makePasswordHash_(password), '有効': YES, '更新日時': nowStamp_() });
    logAudit_('パスワード再設定', staff['スタッフID'], '', 'パスワード', '', '（スプレッドシートのメニューから）', 'メニュー操作');
  });
  if (!password) { ui.alert('そのスタッフIDは見つかりませんでした。'); return; }
  if (isValidStaffId_(id)) CacheService.getScriptCache().remove('fail_' + id);
  ui.alert('スタッフID：' + id + '\n仮パスワード：' + password + '\n\nログインしたら、すぐに自分のパスワードに変えてください。');
}

// ---------------------------------------------------------------------------
// サンプルデータ
// ---------------------------------------------------------------------------
/** メニュー：サンプルデータ。顧客が1件でもあるときは入れない（既存のデータに混ぜない） */
function insertSampleData() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  if (readTable_(SHEET_CUSTOMERS).rows.length) {
    ui.alert('顧客がすでに登録されているので、サンプルデータは入れません。');
    return;
  }
  const answer = ui.alert('サンプルデータ', '架空の顧客5社と、機器・対応履歴・修理・ライセンスの例を入れます。よいですか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  const done = withLock_(function () {
    if (readTable_(SHEET_CUSTOMERS).rows.length) return false;
    insertSampleCore_();
    return true;
  });
  ui.alert(done ? 'サンプルデータを入れました。' : '顧客がすでに登録されているので、入れませんでした。');
}

function addDays_(ymd, days) {
  const p = ymd.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** サンプルデータの本体。withLock_ の中で呼ぶこと */
function insertSampleCore_() {
  const today = todayYmd_();
  const now = nowStamp_();
  const day = function (n) { return addDays_(today, n); };
  const stamp = function (rec) { rec['登録日時'] = now; rec['更新日時'] = now; return rec; };
  const staffName = (readTable_(SHEET_STAFF).rows[0] || {})['表示名'] || '管理者';

  appendRecords_(SHEET_CUSTOMERS, [
    ['C0001', 'サンプル商事株式会社', 'さんぷるしょうじ', '100-0001', '東京都サンプル区見本町1-2-3', '00-0000-0001', '総務 佐藤', '定期保守'],
    ['C0002', 'みなと設計事務所', 'みなとせっけいじむしょ', '100-0002', '東京都サンプル区港町4-5', '00-0000-0002', '所長 鈴木', 'スポット保守'],
    ['C0003', 'あおぞら歯科クリニック', 'あおぞらしかくりにっく', '100-0003', '東京都サンプル区青空町6-7', '00-0000-0003', '事務 高橋', '定期保守'],
    ['C0004', '株式会社ひかり運輸', 'ひかりうんゆ', '100-0004', '東京都サンプル区光町8-9', '00-0000-0004', '田中', 'なし'],
    ['C0005', '北町工務店', 'きたまちこうむてん', '100-0005', '東京都サンプル区北町10', '00-0000-0005', '代表 渡辺', 'スポット保守']
  ].map(function (r) {
    return stamp({
      '顧客ID': r[0], '顧客名': r[1], 'ふりがな': r[2], '郵便番号': r[3], '住所': r[4], '電話': r[5],
      '先方担当者': r[6], '保守契約': r[7], '状態': '有効', 'ポータル公開': NO, 'ポータル表示': PORTAL_TABS_DEFAULT,
      '備考': 'サンプルデータ'
    });
  }));

  appendRecords_(SHEET_DEVICES, [
    ['D00001', 'C0001', '使用中', 'ノート', '本社2F', '総務部', '佐藤', 'HP', 'ProBook 450 G9', 'SMPL0001', day(-700), day(20)],
    ['D00002', 'C0001', '使用中', 'ノート', '本社2F', '営業部', '伊藤', 'HP', 'ProBook 450 G9', 'SMPL0002', day(-700), day(20)],
    ['D00003', 'C0001', '使用中', 'デスクトップ', '本社1F', '経理部', '山本', 'Dell', 'OptiPlex 7010', 'SMPL0003', day(-1200), day(-100)],
    ['D00004', 'C0001', '未使用', 'ノート', '本社2F 倉庫', '', '（予備機）', 'Lenovo', 'ThinkPad L15', 'SMPL0004', day(-1500), ''],
    ['D00005', 'C0001', '使用中', 'NAS', '本社1F サーバー棚', '', '共有', 'その他', 'NAS 4ベイ', 'SMPL0005', day(-400), day(330)],
    ['D00006', 'C0002', '使用中', 'デスクトップ', '事務所', '設計', '鈴木', 'マウスコンピューター', 'DAIV FX', 'SMPL0006', day(-300), day(800)],
    ['D00007', 'C0002', '使用中', 'ノート', '事務所', '設計', '中村', 'Apple', 'MacBook Pro 14', 'SMPL0007', day(-200), day(165)],
    ['D00008', 'C0003', '使用中', 'デスクトップ', '受付', '', '受付PC', 'NEC', 'Mate MKM', 'SMPL0008', day(-900), day(45)],
    ['D00009', 'C0003', '使用中', 'ノート', '診察室1', '', '高橋', '富士通', 'LIFEBOOK A5', 'SMPL0009', day(-900), day(45)],
    ['D00010', 'C0003', '使用中', 'プリンター', '受付', '', '共有', 'その他', 'レーザー複合機', 'SMPL0010', day(-600), ''],
    ['D00011', 'C0004', '使用中', 'ノート', '配車室', '', '田中', 'Dynabook', 'dynabook B65', 'SMPL0011', day(-1000), day(-270)],
    ['D00012', 'C0005', '使用中', 'ノート', '事務所', '', '渡辺', 'ASUS', 'ExpertBook B1', 'SMPL0012', day(-150), day(215)]
  ].map(function (r) {
    return stamp({
      '機器ID': r[0], '顧客ID': r[1], '状況': r[2], '種類': r[3], '設置場所': r[4], '部署': r[5], '利用者': r[6],
      'メーカー': r[7], '機種名': r[8], 'シリアル': r[9], '購入日': r[10], '購入元': '自社', '保証期限': r[11]
    });
  }));

  // 収集ツールから届いた体（てい）の例
  appendRecords_(SHEET_DIAGNOSTICS, [
    ['D00001', 'SMPL0001', 'HP', 'HP ProBook 450 G9', 'SOUMU-01', '192.168.1.21', 'Microsoft Windows 11 Pro', 'Intel(R) Core(TM) i5-1235U', '16 GB', 0, 3, 'なし', '劣化状況: 設計容量比 92%', 'クラッシュダンプなし'],
    ['D00003', 'SMPL0003', 'Dell Inc.', 'OptiPlex 7010', 'KEIRI-01', '192.168.1.31', 'Microsoft Windows 10 Pro', 'Intel(R) Core(TM) i5-3470', '8 GB', 1, 258, '■ EventID 7（C:）[' + today.replace(/-/g, '/') + ' 09:12]\n  デバイス \\Device\\Harddisk0\\DR0 に不良ブロックがあります。', 'バッテリーなし（デスクトップの可能性）', 'クラッシュダンプ 2件検出'],
    ['D00008', 'SMPL0008', 'NEC', 'Mate MKM', 'UKETSUKE-PC', '192.168.0.11', 'Microsoft Windows 11 Pro', 'Intel(R) Core(TM) i5-10500', '8 GB', 0, 12, '重大な異常はなし（リセット/再試行イベントを 2 件検出。しきい値 5 件未満のため今回は経過観察）', 'バッテリーなし（デスクトップの可能性）', 'クラッシュダンプなし']
  ].map(function (r) {
    return {
      '機器ID': r[0], '受信日時': now, 'シリアル': r[1], 'メーカー（取得値）': r[2], '機種名（取得値）': r[3], 'コンピューター名': r[4],
      'IPアドレス': r[5], 'OS': r[6], 'CPU': r[7], 'メモリ': r[8], 'ストレージ': '■ SSD 256GB ★OS\n  健康状態: Healthy',
      'イベント重大': r[9], 'イベントエラー': r[10], 'ディスク関連イベント': r[11], 'バッテリー状態': r[12], 'クラッシュダンプ': r[13],
      'ウイルス対策ソフト': 'ウイルス対策ソフト（有効の可能性）', '稼働時間': '稼働時間: 約 0.3 日', 'ツールバージョン': '1.1.0'
    };
  }));

  appendRecords_(SHEET_ACTIVITIES, [
    ['A000001', 'C0001', 'D00001', day(-40), '電話', 'リモート', '設定依頼', '佐藤', '完了', 'メールソフトの署名を変更。'],
    ['A000002', 'C0001', '', day(-33), '訪問時', '訪問', '設定依頼', '佐藤', '完了', '定期保守で全台を点検。Windows Updateを適用。'],
    ['A000003', 'C0003', 'D00008', day(-25), '電話', '訪問', '障害', '高橋', '完了', '受付PCが起動しない。電源ユニットの接触不良を直した。'],
    ['A000004', 'C0002', 'D00006', day(-18), 'メール', 'リモート', '設定依頼', '鈴木', '完了', 'CADソフトのライセンス再認証。'],
    ['A000005', 'C0001', 'D00003', day(-12), '電話', '電話', '障害', '山本', '完了', '会計ソフトが開かない。再起動で復旧。'],
    ['A000006', 'C0004', 'D00011', day(-9), '電話', '訪問', '障害', '田中', '完了', '画面が映らない。持ち帰って修理へ（修理案件 R00002）。'],
    ['A000007', 'C0003', '', day(-6), '訪問時', '訪問', '設定依頼', '高橋', '完了', '定期保守。バックアップの動作を確認。'],
    ['A000008', 'C0001', 'D00002', day(-4), '電話', 'リモート', '障害', '伊藤', '完了', 'プリンターに印刷できない。ドライバーを入れ直した。'],
    ['A000009', 'C0005', 'D00012', day(-3), 'メール', 'リモート', '相談', '渡辺', '対応中', '見積ソフトの入れ替えを検討中。候補を調査している。'],
    ['A000010', 'C0001', '', day(-2), '訪問時', 'あいさつ', '', '佐藤', '完了', '担当変更のあいさつ。'],
    ['A000011', 'C0002', 'D00007', day(-1), '電話', '電話', '障害', '中村', '保留中', 'Wi-Fiがときどき切れる。次回訪問で確認する。'],
    ['A000012', 'C0003', 'D00009', day(0), '電話', 'リモート', '設定依頼', '高橋', '完了', 'レセプト用の共有フォルダーを追加。']
  ].map(function (r) {
    return stamp({
      '対応ID': r[0], '顧客ID': r[1], '機器ID': r[2], '受付日': r[3], '受付方法': r[4], '対応種別': r[5],
      'インシデント種別': r[6], '先方担当者': r[7], '受付スタッフ': staffName, 'ステータス': r[8], '内容': r[9], 'ピン留め': NO
    });
  }));

  appendRecords_(SHEET_REPAIRS, [
    ['R00001', 'C0001', 'D00004', '', day(-60), day(-52), '完了', '修理', '本体 , AC電源', 'ThinkPad L15', 'SMPL0004', '佐藤', 'キーボードの交換', 'キーが3つ反応しない。キーボードを交換した。'],
    ['R00002', 'C0004', 'D00011', 'A000006', day(-9), '', '実施中', '修理', '本体 , AC電源', 'dynabook B65', 'SMPL0011', '田中', '画面が映らない', '液晶パネルの不良。部品を手配中。'],
    ['R00003', 'C0005', '', '', day(-5), '', '保留中', 'データ復旧', '本体', '外付けHDD 2TB', 'SMPL9001', '渡辺', '外付けHDDが読めない', '見積を出してお客様の返事待ち。'],
    ['R00004', 'C0002', 'D00006', '', day(-2), '', '受付', '設定', '本体', 'DAIV FX', 'SMPL0006', '鈴木', 'メモリ増設', '32GBから64GBへ。']
  ].map(function (r) {
    return stamp({
      '修理ID': r[0], '顧客ID': r[1], '機器ID': r[2], '元の対応ID': r[3], '受付日': r[4], '完了日': r[5],
      'ステータス': r[6], '種別': r[7], '預かり品': r[8], '型番': r[9], 'シリアル': r[10], '先方担当者': r[11],
      '担当スタッフ': staffName, '件名': r[12], '内容': r[13]
    });
  }));

  appendRecords_(SHEET_LICENSES, [
    ['L0001', 'C0001', 'ウイルス対策ソフト', '3年', 5, day(18)],
    ['L0002', 'C0001', 'オフィスソフト（年額）', '1年', 3, day(200)],
    ['L0003', 'C0002', 'CADソフト', '1年', 2, day(-5)],
    ['L0004', 'C0003', 'ウイルス対策ソフト', '3年', 5, day(400)],
    ['L0005', 'C0003', 'PDF編集ソフト', '1年', 2, day(75)]
  ].map(function (r) {
    return stamp({ 'ライセンスID': r[0], '顧客ID': r[1], '製品名': r[2], '契約期間': r[3], '数量': r[4], '有効期限': r[5] });
  }));

  appendRecords_(SHEET_ALLOCATIONS, [
    ['LA00001', 'L0001', 'D00001'], ['LA00002', 'L0001', 'D00002'], ['LA00003', 'L0001', 'D00003'],
    ['LA00004', 'L0002', 'D00001'], ['LA00005', 'L0003', 'D00006'], ['LA00006', 'L0004', 'D00008'],
    ['LA00007', 'L0004', 'D00009']
  ].map(function (r) {
    return { '割当ID': r[0], 'ライセンスID': r[1], '機器ID': r[2], '割当日': day(-30) };
  }));

  appendRecords_(SHEET_CREDENTIALS, [
    ['K00001', 'C0001', 'ライセンス', 'L0001', 'ウイルス対策ソフト 管理画面', 'sample@example.com', 'sample-password-1', 'XXXX-XXXX-XXXX-0001'],
    ['K00002', 'C0001', '機器', 'D00005', 'NAS 管理者', 'admin', 'sample-password-2', ''],
    ['K00003', 'C0003', 'その他', '', 'プロバイダー', 'aozora-sample', 'sample-password-3', '']
  ].map(function (r) {
    return stamp({
      '認証ID': r[0], '顧客ID': r[1], '対象区分': r[2], '対象ID': r[3], '名称': r[4], 'ログインID': r[5],
      'パスワード': r[6], 'シリアルキー': r[7], '備考': 'サンプルデータ（架空の値）'
    });
  }));

  appendRecords_(SHEET_MAINT, [
    ['M00001', 'C0001', '', day(0), '定期保守', '全台を点検。Windows Update とウイルス対策の定義を確認。'],
    ['M00002', 'C0001', '', day(-33), '定期保守', '全台を点検。バックアップの動作を確認。'],
    ['M00003', 'C0003', 'D00008', day(-36), '定期保守', '受付PCの清掃と動作確認。']
  ].map(function (r) {
    return stamp({ '実施ID': r[0], '顧客ID': r[1], '機器ID': r[2], '実施日': r[3], '種別': r[4], '担当スタッフ': staffName, '内容': r[5] });
  }));

  appendRecords_(SHEET_MEMOS, [
    ['N00001', 'C0001', '経理の山本さんのPCは、年度末までに入れ替えを提案する。見積は来月。', YES],
    ['N00002', '', '月末は棚卸し。レンタル機の付属品（AC電源・カバン）を数える。', NO]
  ].map(function (r) {
    return stamp({ 'メモID': r[0], '顧客ID': r[1], '本文': r[2], '作成者': staffName, 'ピン留め': r[3] });
  }));

  appendRecords_(SHEET_NOTICES, [
    ['I0001', '', '年末年始は12月29日から1月3日までお休みをいただきます。', '通常', day(90)],
    ['I0002', 'C0001', 'ウイルス対策ソフトの更新時期が近づいています。担当からご連絡します。', '重要', day(30)]
  ].map(function (r) {
    return stamp({ 'お知らせID': r[0], '顧客ID': r[1], '本文': r[2], '重要度': r[3], '掲載期限': r[4] });
  }));

  appendRecords_(SHEET_RENTALS, [
    ['RT0001', '代替機 ノート1号', 'ノート', '利用可能', '代替機', 'HP', 'ProBook 450 G8', 'RENT0001'],
    ['RT0002', '代替機 ノート2号', 'ノート', '利用可能', '代替機', 'Dell', 'Latitude 3520', 'RENT0002'],
    ['RT0003', '貸出用プロジェクター', 'その他', '利用可能', 'イベント貸出', '', '', 'RENT0003']
  ].map(function (r) {
    return stamp({ 'レンタルID': r[0], '名称': r[1], '種類': r[2], '状態': r[3], '用途': r[4], 'メーカー': r[5], '機種名': r[6], 'シリアル': r[7] });
  }));

  appendRecords_(SHEET_LOANS, [
    ['LN00001', 'RT0001', 'C0004', '', day(-9), day(2), '', 'R00002', '修理中の代替機'],
    ['LN00002', 'RT0003', '', '町内会（サンプル）', day(-20), day(-18), day(-18), '', '']
  ].map(function (r) {
    return stamp({ '貸出ID': r[0], 'レンタルID': r[1], '顧客ID': r[2], '貸出先': r[3], '貸出日': r[4], '返却予定日': r[5], '返却日': r[6], '担当スタッフ': staffName, '修理ID': r[7], '備考': r[8] });
  }));

  appendRecords_(SHEET_LAYOUTS, [stamp({
    'レイアウトID': 'LY0001', '顧客ID': 'C0001', '名前': '本社2F', '背景色': '#ffffff',
    '図形': JSON.stringify([
      { type: 'rect', x: 4, y: 6, w: 92, h: 86, color: '', text: '' },
      { type: 'text', x: 7, y: 9, text: '本社 2F 事務室', size: 16, color: '' },
      { type: 'desk', x: 12, y: 24, w: 20, h: 12, color: '', text: '総務' },
      { type: 'desk', x: 40, y: 24, w: 20, h: 12, color: '', text: '営業' },
      { type: 'desk', x: 68, y: 24, w: 20, h: 12, color: '', text: '経理' },
      { type: 'pin', x: 22, y: 44, deviceId: 'D00001' },
      { type: 'pin', x: 50, y: 44, deviceId: 'D00002' },
      { type: 'pin', x: 78, y: 44, deviceId: 'D00003' },
      { type: 'icon', x: 14, y: 76, icon: '🖨️', size: 28, text: '複合機' },
      { type: 'icon', x: 86, y: 76, icon: '🚪', size: 28, text: '入口' },
      { type: 'line', x1: 4, y1: 64, x2: 60, y2: 64, color: '', width: 2 }
    ])
  })]);

  logAudit_('サンプルデータ投入', '', '', '', '', '顧客5・機器12・対応12・修理4・ライセンス5・保守3・メモ2・お知らせ2・レンタル3・貸出2・レイアウト1', 'メニュー操作');
}
