/**
 * Setup.gs … スプレッドシートのメニュー、初期設定、サンプルデータ
 *
 * メニューから呼ぶ関数（onOpen / runSetup / insertSampleData / resetPasswordFromMenu、Alerts.gs の setupDailyTrigger / removeDailyTrigger）は、
 * 最初に SpreadsheetApp.getUi() を呼ぶ。ウェブアプリ経由で第三者が呼んでも、そこで止まって何も起きない。
 * 仮パスワードは画面のダイアログにだけ出し、戻り値では返さない。
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Setup.gs'] = '0.138.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu(APP_NAME)
    .addItem('初期設定（シートを作る・足りない列を足す）', 'runSetup')
    .addItem('サンプルデータを入れる', 'insertSampleData')
    .addSeparator()
    .addItem('毎朝の通知を設定（設定し直すときも）', 'setupDailyTrigger')
    .addItem('毎朝の通知をやめる', 'removeDailyTrigger')
    .addSeparator()
    .addItem('起こしておく（始業時間のあいだ30分ごと）を設定', 'setupWarmTrigger')
    .addItem('起こしておくのをやめる', 'removeWarmTrigger')
    .addItem('控えの状態を調べる（遅い時）', 'cacheReport')
    .addItem('カレンダーを使えるようにする（承認）', 'authorizeCalendar')
    .addItem('RSSを使えるようにする（外部接続の承認）', 'authorizeRss')
    .addSeparator()
    .addItem('スタッフのパスワードを再設定', 'resetPasswordFromMenu')
    .addSeparator()
    .addItem('バックアップを今作る', 'backupNow')
    .addItem('毎日のバックアップを設定（夜中の3時台）', 'setupBackupTrigger')
    .addItem('毎日のバックアップをやめる', 'removeBackupTrigger')
    .addItem('古い変更履歴を別のシートへ移す', 'archiveOldAudit')
    .addItem('古い対応履歴を別のシートへ移す（1年より前の完了分）', 'archiveOldActivities')
    .addItem('使っていないシートを片づける（バックアップを作ってから消す）', 'cleanupUnusedSheets')
    .addToUi();  // 前のシステムからの取り込み（Migrate.gs を入れてある時だけ、メニューを出す）
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

/** 古いステータス名を新しい名前に書き換える。何度実行しても同じ（もう無ければ0件）。書き換えた件数を返す */
function renameStatuses_() {
  let n = 0;
  [[SHEET_ACTIVITIES, STATUS_RENAMES.activity], [SHEET_REPAIRS, STATUS_RENAMES.repair]].forEach(function (x) {
    const sheet = getSs_().getSheetByName(x[0]);
    if (!sheet) return;
    readTable_(x[0]).rows.forEach(function (r) {
      const to = x[1][r['ステータス']];
      if (to) { updateRecord_(x[0], r._row, { 'ステータス': to }); n++; }
    });
  });
  return n;
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
      // v0.125.0：名前を変えた列は、見出しを書き換える（新しい名前の列がまだ無い時だけ）
      const ren = HEADER_RENAMES[name] || {};
      Object.keys(ren).forEach(function (from) {
        const i = have.indexOf(from);
        if (i === -1 || have.indexOf(ren[from]) !== -1) return;
        sheet.getRange(1, i + 1, 1, 1).setValues([[ren[from]]]);
        have[i] = ren[from];
        report.addedColumns.push(name + '「' + from + '」→「' + ren[from] + '」（名前を変えました）');
        if (from === '年間保守料金') report.warnings.push('顧客の「年間保守料金」を「月額保守料金」に変えました。入っている金額は年額のままなので、1か月あたりの金額に直してください。');
      });
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

  // v0.81.0 の「商談」シートがあれば、開発案件へ移す（1回だけ。商談シートは消さずに残す）
  migrateDealsToProjects_(ss, report);

  // 選択肢：その区分に1件も無い時だけ、最初の値を入れる
  const optionRows = readTable_(SHEET_OPTIONS).rows;
  const seeds = [];
  OPTION_CATEGORIES.forEach(function (cat) {
    if (optionRows.some(function (r) { return String(r['区分']).trim() === cat; })) return;
    OPTION_DEFAULTS[cat].forEach(function (value, i) {
      if (OPTION_BASE[cat] && OPTION_BASE[cat].indexOf(value) !== -1) return;
      seeds.push({ '区分': cat, '値': value, '表示順': (i + 1) * 10, '有効': YES });
    });
  });
  appendRecords_(SHEET_OPTIONS, seeds);

  // Tips：1件も無い時だけ、最初の文を入れる（そのあとは、RSS と新しい文の追加で足される。シートで直してもよい）
  if (!readTable_(SHEET_TIPS).rows.length) {
    const tipNow = nowStamp_();
    appendRecords_(SHEET_TIPS, WINDOWS_TIPS.map(function (t, i) {
      let num = String(i + 1);
      while (num.length < 4) num = '0' + num;
      return { 'TipID': 'T' + num, '見出し': t[0], '説明': t[1], '有効': YES, '登録日時': tipNow };
    }));
    CacheService.getScriptCache().remove(TIPS_CACHE_KEY);
  }

  // スタッフ：1人もいない時だけ、最初の管理者を作る
  if (!readTable_(SHEET_STAFF).rows.length) {
    const password = randomPassword_(10);
    const hash = makePasswordHash_(password);
    const now = nowStamp_();
    appendRecord_(SHEET_STAFF, {
      'スタッフID': 'admin', '表示名': '管理者', 'パスワードハッシュ': hash,
      '権限': ROLE_ADMIN, '有効': YES, '登録日時': now, '更新日時': now
    });
    markTempPassword_('admin', hash);
    report.adminPassword = password;
  }

  // 古いステータス名（対応の「保留中」、修理の「実施中」「保留中」）を、「対応中」に書き換える（v0.52.0）
  const renamed = renameStatuses_();
  if (renamed) report.warnings.push('ステータスを「対応中」にそろえました：' + renamed + '件');

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
    // お客さんが足した列がある時は、その列の書式には触らない
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
    const hash = makePasswordHash_(password);
    updateRecord_(SHEET_STAFF, staff._row, { 'パスワードハッシュ': hash, '有効': YES, '更新日時': nowStamp_() });
    markTempPassword_(staff['スタッフID'], hash);
    logAudit_('パスワード再設定', staff['スタッフID'], '', 'パスワード', '', '（スプレッドシートのメニューから）', 'メニュー操作');
  });
  if (!password) { ui.alert('そのスタッフIDは見つかりませんでした。'); return; }
  if (isValidStaffId_(id)) CacheService.getScriptCache().remove('fail_' + id);
  ui.alert('スタッフID：' + id + '\n仮パスワード：' + password + '\n\nログインしたら、すぐに自分のパスワードに変えてください。');
}

// ---------------------------------------------------------------------------
// サンプルデータ
// ---------------------------------------------------------------------------
/** メニュー：サンプルデータ。顧客が1件でもある時は入れない（既存のデータに混ぜない） */
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
    ['A000011', 'C0002', 'D00007', day(-1), '電話', '電話', '障害', '中村', '対応中', 'Wi-Fiがときどき切れる。次回訪問で確認する。'],
    ['A000012', 'C0003', 'D00009', day(0), '電話', 'リモート', '設定依頼', '高橋', '完了', 'レセプト用の共有フォルダーを追加。']
  ].map(function (r) {
    return stamp({
      '対応ID': r[0], '顧客ID': r[1], '機器ID': r[2], '受付日': r[3], '受付方法': r[4], '対応種別': r[5],
      'インシデント種別': r[6], '先方担当者': r[7], '受付スタッフ': staffName, 'ステータス': r[8], '内容': r[9], 'ピン留め': NO
    });
  }));

  appendRecords_(SHEET_REPAIRS, [
    ['R00001', 'C0001', 'D00004', '', day(-60), day(-52), '完了', '修理', '本体 , AC電源', 'ThinkPad L15', 'SMPL0004', '佐藤', 'キーボードの交換', 'キーが3つ反応しない。キーボードを交換した。'],
    ['R00002', 'C0004', 'D00011', 'A000006', day(-9), '', '対応中', '修理', '本体 , AC電源', 'dynabook B65', 'SMPL0011', '田中', '画面が映らない', '液晶パネルの不良。部品を手配中。'],
    ['R00003', 'C0005', '', '', day(-5), '', '対応中', 'データ復旧', '本体', '外付けHDD 2TB', 'SMPL9001', '渡辺', '外付けHDDが読めない', '見積を出してお客様の返事待ち。'],
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


/**
 * v0.81.0（テスト版）の「商談」シートの中身を、開発案件に移す（v0.82.0）。
 *   - 商談にもう案件がつながっていれば、その案件に先方の情報（連絡先・確度・次の連絡日など）を足す
 *   - 案件がなければ、商談1件につき案件を1件作る（状態「受注」で顧客がいれば「要件確認」、顧客がいなければ「見積」）
 *   - 営業活動は、商談のかわりに案件につなぎ直す
 * 何度やっても二重に移さない（案件の「商談ID」で見分ける）。商談シートは、消さずに残す。
 */
function migrateDealsToProjects_(ss, report) {
  const sheet = ss.getSheetByName(SHEET_DEALS);
  if (!sheet || sheet.getLastRow() < 2) return;
  const deals = readTable_(SHEET_DEALS).rows;
  if (!deals.length) return;
  const projects = readTable_(SHEET_PROJECTS).rows;
  const byDeal = {};
  projects.forEach(function (pj) { if (pj['商談ID']) byDeal[String(pj['商談ID'])] = pj; });
  const now = nowStamp_();
  const map = {};          // 商談ID → 案件ID
  let moved = 0;
  deals.forEach(function (d) {
    const did = String(d['商談ID']);
    if (!did) return;
    if (byDeal[did]) { map[did] = String(byDeal[did]['案件ID']); return; }
    const linked = d['案件ID'] ? projects.filter(function (pj) { return String(pj['案件ID']) === String(d['案件ID']); })[0] : null;
    const extra = {
      '先方名': d['見込み客名'], '先方担当者': d['先方担当者'], '電話': d['電話'], 'メール': d['メール'],
      '確度': d['確度'], '次の連絡日': d['次の連絡日'], '失注理由': d['失注理由'], '商談ID': did, '更新日時': now
    };
    if (linked) {
      updateRecord_(SHEET_PROJECTS, linked._row, extra);
      map[did] = String(linked['案件ID']);
    } else {
      let state = d['状態'];
      if (state === DEAL_WON) state = d['顧客ID'] ? PROJECT_ORDERED : '見積';
      if (PROJECT_STATES.indexOf(state) === -1) state = PROJECT_FIRST;
      const pid = nextId_(SHEET_PROJECTS, '案件ID', ENTITIES.project.prefix, ENTITIES.project.digits);
      const rec = {
        '案件ID': pid, '案件名': d['見込み客名'], '顧客ID': d['顧客ID'], '種類': '', '状態': state, '進捗': 0,
        '金額': d['金額'], '担当': d['担当'], '備考': d['内容'], 'お客様に見せる': NO, '登録日時': d['登録日時'] || now
      };
      Object.keys(extra).forEach(function (k) { rec[k] = extra[k]; });
      appendRecord_(SHEET_PROJECTS, rec);
      map[did] = pid;
    }
    moved++;
  });
  readTable_(SHEET_SALESLOGS).rows.forEach(function (l) {
    if (l['案件ID'] || !l['商談ID'] || !map[String(l['商談ID'])]) return;
    updateRecord_(SHEET_SALESLOGS, l._row, { '案件ID': map[String(l['商談ID'])], '更新日時': now });
  });
  if (moved) report.warnings.push('商談 ' + moved + '件を、案件に移しました（「商談」シートは、そのまま残してあります。いらなければ消して構いません）');
}

// ---------------------------------------------------------------------------
// バックアップ（v0.97.0）
// ---------------------------------------------------------------------------
/** 今の時刻（バックアップの名前用。テストで差し替えられるよう、関数にしてある） */
function backupNowDate_() { return new Date(); }

/**
 * このスプレッドシートのコピーを、同じ場所の「○○_バックアップ」フォルダーに作る。
 * 新しい順に BACKUP_KEEP 件を残し、それより古いものはごみ箱へ移す（ごみ箱からは戻せる）。
 * @param {boolean} manual true … 今作る（同じ日でも作る）。false … 毎日の自動（その日のぶんがあれば作らない）
 * @return {{folder:string, created:string, kept:number, trashed:Array<string>}}
 */
function backupCore_(manual) {
  const tz = scriptTz_();
  const ssFile = DriveApp.getFileById(getSs_().getId());
  const base = ssFile.getName();
  const parents = ssFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const folderName = base + '_バックアップ';
  const found = parent.getFoldersByName(folderName);
  const folder = found.hasNext() ? found.next() : parent.createFolder(folderName);
  const prefix = base + '_';
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getName().indexOf(prefix) === 0) files.push({ file: f, name: f.getName() });
  }
  const now = backupNowDate_();
  const today = Utilities.formatDate(now, tz, 'yyyyMMdd');
  let created = '';
  if (manual || !files.some(function (x) { return x.name.indexOf(prefix + today) === 0; })) {
    created = prefix + Utilities.formatDate(now, tz, manual ? 'yyyyMMdd_HHmm' : 'yyyyMMdd');
    // 同じ名前（同じ分に2回）がある時は、秒を足して区別する
    if (files.some(function (x) { return x.name === created; })) created += Utilities.formatDate(now, tz, 'ss');
    files.push({ file: ssFile.makeCopy(created, folder), name: created });
  }
  files.sort(function (a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; });      // 新しい順
  const old = files.slice(BACKUP_KEEP);
  old.forEach(function (x) { x.file.setTrashed(true); });
  return { folder: folderName, created: created, kept: Math.min(files.length, BACKUP_KEEP), trashed: old.map(function (x) { return x.name; }) };
}

/** バックアップの結果を覚える（失敗した時に気づけるように） */
function saveBackupStatus_(status) {
  try { PropertiesService.getScriptProperties().setProperty(BACKUP_STATUS_PROPERTY, JSON.stringify(status)); } catch (e) { console.warn('バックアップの結果を覚えられませんでした: ' + e); }
}

/** トリガーから毎日呼ばれる。失敗したら、通知先のメールへ知らせる */
function runDailyBackup(e) {
  // 本物のトリガーから呼ばれた時だけ動く（ウェブアプリ経由で第三者が呼んでも、何もしない。runDailyAlerts と同じ）
  const uid = e && typeof e.triggerUid === 'string' ? e.triggerUid : '';
  const real = !!uid && ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === BACKUP_TRIGGER_FUNCTION && String(t.getUniqueId()) === uid;
  });
  if (!real) return;
  if (!isSetupDone_()) return;
  try {
    const r = backupCore_(false);
    saveBackupStatus_({ at: nowStamp_(), ok: true, name: r.created, message: r.created ? 'バックアップを作りました' : '今日のぶんは作ってあります' });
    console.log('バックアップ：' + (r.created || '（今日のぶんはあり）') + ' 残り' + r.kept + '件 ごみ箱へ' + r.trashed.length + '件');
  } catch (e) {
    console.error('バックアップに失敗しました: ' + (e && e.stack ? e.stack : e));
    saveBackupStatus_({ at: nowStamp_(), ok: false, name: '', message: String(e && e.message ? e.message : e) });
    try {
      const to = alertRecipients_(getSettings_());
      if (to.length) MailApp.sendEmail(to.join(','), '【' + APP_NAME + '】バックアップに失敗しました', '毎日のバックアップが失敗しました。\n' + String(e && e.message ? e.message : e) + '\n\nスプレッドシートのメニュー「' + APP_NAME + '」→「バックアップを今作る」を試してください。');
    } catch (e2) { console.warn('失敗の知らせを送れませんでした: ' + e2); }
  }
}

/** メニュー：バックアップを今作る */
function backupNow() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('バックアップ', 'このスプレッドシートのコピーを、同じ場所の「○○_バックアップ」フォルダーに作ります。\n新しい' + BACKUP_KEEP + '件を残し、それより古いものはごみ箱へ移します。\n\n作りますか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  try {
    const r = backupCore_(true);
    saveBackupStatus_({ at: nowStamp_(), ok: true, name: r.created, message: 'バックアップを作りました' });
    ui.alert('バックアップを作りました。\n\nフォルダー：' + r.folder + '\nファイル：' + r.created + '\n残してある数：' + r.kept + '件' + (r.trashed.length ? '\nごみ箱へ移した古いもの：' + r.trashed.length + '件' : ''));
  } catch (e) {
    console.error('バックアップに失敗しました: ' + (e && e.stack ? e.stack : e));
    ui.alert('バックアップを作れませんでした。\n' + String(e && e.message ? e.message : e));
  }
}

function deleteBackupTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BACKUP_TRIGGER_FUNCTION) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/** メニュー：毎日のバックアップを設定する（設定し直すときも同じ） */
function setupBackupTrigger() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  deleteBackupTriggers_();
  ScriptApp.newTrigger(BACKUP_TRIGGER_FUNCTION).timeBased().everyDays(1).atHour(BACKUP_HOUR).create();
  ui.alert('毎日 ' + BACKUP_HOUR + ' 時台に、バックアップを作るようにしました。\n新しい' + BACKUP_KEEP + '日ぶんを残します。\n\n（Googleドライブへの許可を求められた時は、許可してください。失敗した時は、通知先のメールに知らせます）');
}

/** メニュー：毎日のバックアップをやめる */
function removeBackupTrigger() {
  const ui = SpreadsheetApp.getUi();
  const n = deleteBackupTriggers_();
  ui.alert(n ? '毎日のバックアップをやめました。（今までのバックアップは、そのまま残ります）' : '毎日のバックアップは設定されていません。');
}

// ---------------------------------------------------------------------------
// 古い変更履歴を別のシートへ移す（v0.97.0）
// ---------------------------------------------------------------------------
/** 変更履歴の先頭から、cutoff（yyyy-MM-dd）より古い行が何行続くか（変更履歴は古い順に足している） */
function countOldAudit_(cutoff) {
  const rows = readTable_(SHEET_AUDIT).rows;
  let n = 0;
  while (n < rows.length && String(rows[n]['日時']).slice(0, 10) < cutoff) n++;
  return n;
}

/**
 * 変更履歴の古い行を「変更履歴_退避」へ移す（消さない）。withLock_ の中で呼ぶこと。
 * 移した行が退避シートに入ったのを確かめてから、元のシートの行を消す。
 * @return {number} 移した行数
 */
function archiveAuditCore_(cutoff) {
  const n = countOldAudit_(cutoff);
  if (!n) return 0;
  const table = readTable_(SHEET_AUDIT);
  const sheet = table.sheet;
  const firstRow = table.rows[0]._row;
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (table.rows[n - 1]._row - firstRow !== n - 1) throw appError_('invalid', '変更履歴に空の行が混ざっているので、移せません。シートを確かめてください。');
  const src = sheet.getRange(firstRow, 1, n, lastCol);
  const values = src.getValues();
  const formats = src.getNumberFormats();
  let arch = getSs_().getSheetByName(SHEET_AUDIT_ARCHIVE);
  if (!arch) {
    arch = getSs_().insertSheet(SHEET_AUDIT_ARCHIVE);
    arch.getRange(1, 1, 1, table.headers.length).setValues([table.headers]);
    arch.setFrozenRows(1);
  }
  const start = Math.max(arch.getLastRow(), 1) + 1;
  const need = start + n - 1;
  if (need > arch.getMaxRows()) arch.insertRowsAfter(arch.getMaxRows(), need - arch.getMaxRows() + 100);
  const dest = arch.getRange(start, 1, n, lastCol);
  dest.setNumberFormats(formats);
  dest.setValues(values);
  // 退避シートに入ったことを確かめてから、元の行を消す
  const check = arch.getRange(start + n - 1, 1, 1, lastCol).getValues()[0];
  if (String(check[0]) !== String(values[n - 1][0]) || String(check[1]) !== String(values[n - 1][1])) {
    throw appError_('invalid', '退避シートに書けたことを確かめられなかったので、元の行は消していません。');
  }
  sheet.deleteRows(firstRow, n);
  forgetRows_(SHEET_AUDIT);
  markDirty_(SHEET_AUDIT);
  return n;
}

/** メニュー：古い変更履歴を別のシートへ移す */
// ---------------------------------------------------------------------------
// 古い対応履歴を「対応履歴_退避」へ移す（v0.112.0）
//   対象：受付日が ACTIVITY_KEEP_DAYS 日より前で、完了したもの（未完了は、古くても移さない）。
//   移したものも、顧客ページの「対応」と、期間を指定した対応の一覧には出る（listActivities が退避シートも読む）。
//   移したものを直すと、自動で元のシートに戻してから保存する。普段の読み込み（最初の画面・要対応・更新）は、元のシートだけ読むので軽くなる。
// ---------------------------------------------------------------------------
function activityArchiveTargets_(cutoff) {
  return readTable_(SHEET_ACTIVITIES).rows.filter(function (r) {
    const d = String(r['受付日'] || '');
    return d && d < cutoff && r['ステータス'] === ACTIVITY_DONE;
  });
}

/** withLock_ の中で呼ぶ。移した行数を返す */
function archiveActivitiesCore_(cutoff) {
  const targets = activityArchiveTargets_(cutoff);
  if (!targets.length) return 0;
  const table = readTable_(SHEET_ACTIVITIES);
  const sheet = table.sheet;
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const lastRow = sheet.getLastRow();
  const all = sheet.getRange(2, 1, lastRow - 1, lastCol);
  const values = all.getValues(), formats = all.getNumberFormats();
  const rowsNo = targets.map(function (r) { return r._row; }).sort(function (a, b) { return a - b; });
  const pickV = rowsNo.map(function (n) { return values[n - 2]; }), pickF = rowsNo.map(function (n) { return formats[n - 2]; });
  let arch = getSs_().getSheetByName(SHEET_ACTIVITIES_ARCHIVE);
  if (!arch) {
    arch = getSs_().insertSheet(SHEET_ACTIVITIES_ARCHIVE);
    const head = sheet.getRange(1, 1, 1, lastCol).getValues();
    arch.getRange(1, 1, 1, lastCol).setValues(head);
    arch.setFrozenRows(1);
  }
  if (arch.getMaxColumns() < lastCol) arch.insertColumnsAfter(arch.getMaxColumns(), lastCol - arch.getMaxColumns());
  const start = Math.max(arch.getLastRow(), 1) + 1;
  const need = start + pickV.length - 1;
  if (need > arch.getMaxRows()) arch.insertRowsAfter(arch.getMaxRows(), need - arch.getMaxRows() + 100);
  const dest = arch.getRange(start, 1, pickV.length, lastCol);
  dest.setNumberFormats(pickF);
  dest.setValues(pickV);
  const check = arch.getRange(need, 1, 1, lastCol).getValues()[0];
  if (String(check[0]) !== String(pickV[pickV.length - 1][0])) throw appError_('invalid', '退避シートに書けたことを確かめられなかったので、元の行は消していません。');
  // 番号の続きを覚えておく（移したあとも、同じ番号を出さないため）
  const idCol = table.headers.indexOf('対応ID');
  let maxNo = Number(PropertiesService.getScriptProperties().getProperty('idfloor_' + SHEET_ACTIVITIES)) || 0;
  pickV.forEach(function (v) { const m = /^A(\d+)$/.exec(String(v[idCol])); if (m) maxNo = Math.max(maxNo, Number(m[1])); });
  PropertiesService.getScriptProperties().setProperty('idfloor_' + SHEET_ACTIVITIES, String(maxNo));
  // 下の行から、続いているかたまりごとに消す
  for (let i = rowsNo.length - 1; i >= 0;) {
    let j = i;
    while (j - 1 >= 0 && rowsNo[j - 1] === rowsNo[j] - 1) j--;
    sheet.deleteRows(rowsNo[j], i - j + 1);
    i = j - 1;
  }
  forgetSheet_(SHEET_ACTIVITIES);
  markDirty_(SHEET_ACTIVITIES);
  return rowsNo.length;
}

/** メニュー：古い対応履歴を移す */
function archiveOldActivities() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const cutoff = addDays_(todayYmd_(), -ACTIVITY_KEEP_DAYS);
  const n = activityArchiveTargets_(cutoff).length;
  if (!n) { ui.alert('移す対応履歴はありません。（受付日が ' + cutoff + ' より前の、完了したものが対象です）'); return; }
  const answer = ui.alert('古い対応履歴を移す', '受付日が ' + cutoff + ' より前の、完了した対応履歴 ' + n + '件を、「' + SHEET_ACTIVITIES_ARCHIVE + '」シートへ移します。\n消えるわけではありません。顧客ページの「対応」には、これまでどおり出ます。\n普段の読み込みが軽くなります。\n\n移しますか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  try {
    const moved = withLock_(function () { return archiveActivitiesCore_(cutoff); });
    cacheBumpAll_();
    ui.alert(moved + '件を「' + SHEET_ACTIVITIES_ARCHIVE + '」シートへ移しました。');
  } catch (e) {
    console.error('対応履歴を移せませんでした: ' + (e && e.stack ? e.stack : e));
    ui.alert('移せませんでした。\n' + String(e && e.message ? e.message : e));
  }
}

/** 退避シートの対応履歴（listActivities 用）。無ければ [] */
function archivedActivities_() {
  const arch = getSs_().getSheetByName(SHEET_ACTIVITIES_ARCHIVE);
  if (!arch || arch.getLastRow() < 2) return [];
  const values = arch.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const types = typeMap_(SHEET_ACTIVITIES);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _row: i + 1 };
    let empty = true;
    headers.forEach(function (h, j) {
      if (!h || types[h] === undefined) return;
      const v = fromCell_(types[h], values[i][j]);
      if (v !== '') empty = false;
      obj[h] = v;
    });
    if (!empty) out.push(obj);
  }
  return out;
}

/** 退避した対応を、元のシートに戻す（直す・消す時に呼ぶ。withLock_ の中）。戻せたら true */
function restoreArchivedActivity_(id) {
  const arch = getSs_().getSheetByName(SHEET_ACTIVITIES_ARCHIVE);
  if (!arch || arch.getLastRow() < 2) return false;
  const lastCol = Math.max(arch.getLastColumn(), 1);
  const headers = arch.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const col = headers.indexOf('対応ID');
  if (col === -1) return false;
  const ids = arch.getRange(2, col + 1, arch.getLastRow() - 1, 1).getValues();
  let at = -1;
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { at = i + 2; break; }
  if (at === -1) return false;
  const src = arch.getRange(at, 1, 1, lastCol);
  const vals = src.getValues()[0], fmts = src.getNumberFormats()[0];
  const main = tableHead_(SHEET_ACTIVITIES);
  // 列の並びが違っても、見出しの名前で合わせる
  const row = main.headers.map(function (h) { const j = headers.indexOf(h); return j === -1 ? '' : vals[j]; });
  const fmt = main.headers.map(function (h) { const j = headers.indexOf(h); return j === -1 ? '@' : fmts[j]; });
  const dst = main.sheet.getLastRow() + 1;
  if (dst > main.sheet.getMaxRows()) main.sheet.insertRowsAfter(main.sheet.getMaxRows(), 50);
  const range = main.sheet.getRange(dst, 1, 1, row.length);
  range.setNumberFormats([fmt]);
  range.setValues([row]);
  arch.deleteRow(at);
  forgetSheet_(SHEET_ACTIVITIES);
  markDirty_(SHEET_ACTIVITIES);
  return true;
}

function archiveOldAudit() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const cutoff = addDays_(todayYmd_(), -AUDIT_KEEP_DAYS);
  const n = countOldAudit_(cutoff);
  if (!n) { ui.alert('移す変更履歴はありません。（' + cutoff + ' より前のものが対象です）'); return; }
  const answer = ui.alert('古い変更履歴を移す', cutoff + ' より前の変更履歴 ' + n + '件を、「' + SHEET_AUDIT_ARCHIVE + '」シートへ移します。\n消えるわけではありません（退避シートに残ります）。\n\n移しますか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  try {
    const moved = withLock_(function () { return archiveAuditCore_(cutoff); });
    cacheBumpAll_();
    ui.alert(moved + '件を「' + SHEET_AUDIT_ARCHIVE + '」シートへ移しました。');
  } catch (e) {
    console.error('変更履歴を移せませんでした: ' + (e && e.stack ? e.stack : e));
    ui.alert('移せませんでした。\n' + String(e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------------------
// 使っていないシートを片づける（v0.136.0）
// ---------------------------------------------------------------------------
/**
 * アプリが使っていないシートを、2つに分けて返す。
 *   safe   … アプリが前に作って、今は使わないもの（商談・移行レポート）と、空のシート
 *   others … アプリは使っていないが、中身があるもの（自分で作ったシートかもしれない）
 * 使っているシート（SHEET_ORDER）と、退避のシート（変更履歴_退避・対応履歴_退避。顧客の画面から読む）は入れない。
 */
function unusedSheets_() {
  const ss = getSs_();
  const keep = {};
  SHEET_ORDER.forEach(function (n) { keep[n] = true; });
  keep[SHEET_AUDIT_ARCHIVE] = true;
  keep[SHEET_ACTIVITIES_ARCHIVE] = true;
  const out = { safe: [], others: [], blocked: [] };
  ss.getSheets().forEach(function (sh) {
    const name = sh.getName();
    if (keep[name]) return;
    const rows = Math.max(0, sh.getLastRow() - 1);
    const item = { name: name, rows: rows };
    if (name === SHEET_DEALS) {
      // v0.82.0 で開発案件にまとめた古いシート。全部が開発案件へ移っていれば消してよい
      const moved = {};
      if (ss.getSheetByName(SHEET_PROJECTS)) readTable_(SHEET_PROJECTS).rows.forEach(function (pj) { if (pj['商談ID']) moved[String(pj['商談ID'])] = true; });
      const left = readTable_(SHEET_DEALS).rows.filter(function (d) { return d['商談ID'] && !moved[String(d['商談ID'])]; }).length;
      if (left) { item.note = '開発案件へまだ移していない商談が ' + left + '件あります。先に「初期設定」を実行してください'; out.blocked.push(item); return; }
      item.note = '開発案件にまとめた古いシート';
      out.safe.push(item);
      return;
    }
    if (typeof MIG_REPORT_SHEET !== 'undefined' && name === MIG_REPORT_SHEET) { item.note = '前のシステムから取り込んだ時の記録'; out.safe.push(item); return; }
    if (sh.getLastRow() <= 1 && sh.getLastColumn() <= 1 && !String(sh.getRange(1, 1).getValue()).trim()) { item.note = '空のシート'; out.safe.push(item); return; }
    item.note = rows + '行';
    out.others.push(item);
  });
  return out;
}

/** メニュー：使っていないシートを片づける。消す前に、スプレッドシートのバックアップを作る（作れなければ消さない） */
function cleanupUnusedSheets() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const found = unusedSheets_();
  const line = function (it) { return '・' + it.name + '（' + it.note + '）'; };
  const blockedNote = found.blocked.length ? '\n\n消せないもの：\n' + found.blocked.map(line).join('\n') : '';
  if (!found.safe.length && !found.others.length) { ui.alert('使っていないシートはありません。' + blockedNote); return; }
  let names = [];
  if (found.safe.length) {
    const a = ui.alert('使っていないシートを片づける',
      'アプリが使っていないシートです。消す前に、スプレッドシートのバックアップを作ります。\n\n' + found.safe.map(line).join('\n') + blockedNote + '\n\n消しますか？',
      ui.ButtonSet.YES_NO);
    if (a === ui.Button.YES) names = names.concat(found.safe.map(function (it) { return it.name; }));
  }
  if (found.others.length) {
    const b = ui.alert('他のシート',
      'アプリは使っていませんが、中身があるシートです。自分で作ったシート・他の用事で使っているシートなら「いいえ」を押してください。\n\n' + found.others.map(line).join('\n') + '\n\nこれらも消しますか？',
      ui.ButtonSet.YES_NO);
    if (b === ui.Button.YES) names = names.concat(found.others.map(function (it) { return it.name; }));
  }
  if (!names.length) { ui.alert('何も消しませんでした。'); return; }
  let backup;
  try {
    backup = backupCore_(true);
    saveBackupStatus_({ at: nowStamp_(), ok: true, name: backup.created, message: 'シートを片づける前のバックアップ' });
  } catch (e) {
    ui.alert('バックアップを作れなかったので、シートは消していません。\n' + String(e && e.message ? e.message : e));
    return;
  }
  const done = withLock_(function () {
    const ss = getSs_();
    const gone = [];
    names.forEach(function (n) {
      const sh = ss.getSheetByName(n);
      if (!sh || ss.getSheets().length <= 1) return;
      ss.deleteSheet(sh);
      gone.push(n);
    });
    return gone;
  });
  cacheBumpAll_();
  logAuditSafe_('シートの片づけ', done.join('、'));
  ui.alert('消したシート：' + (done.length ? done.join('、') : 'なし') + '\n\n消す前のバックアップ：' + backup.created + '（' + backup.folder + '）\n間違って消した時は、このバックアップから写してください。');
}
function logAuditSafe_(kind, text) {
  try { withLock_(function () { logAudit_(kind, '', '', '', '', auditText_(text), 'メニュー'); }); } catch (e) { console.warn('変更履歴に残せませんでした: ' + e); }
}
