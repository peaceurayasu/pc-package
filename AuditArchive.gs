/**
 * AuditArchive.gs … 古い変更履歴を、保管用のスプレッドシートへ移す（v0.40.0）
 *
 * 変更履歴シートは保存のたびに1行ずつ増え、消えない。何年も使うと、変更履歴の画面が遅くなり、
 * スプレッドシートのセルの上限（1000万）にも近づく。そこで毎朝の処理で、
 * 設定「変更履歴を残す日数」より古い行を、別のスプレッドシート（保管用）へ移す。
 *
 * - 保管用のスプレッドシートは、最初に移すときに作る（デプロイした人のドライブ、「PC管理パッケージのファイル」フォルダー）
 * - 保管用では、年ごとのシート（「2025」など）に入れる。消さない
 * - 変更履歴は上から古い順に並んでいる。上から続けて「古い」行だけを移す（日時の無い行・新しい行で止まる）
 * - 1回に移すのは AUDIT_ARCHIVE_MAX_ROWS 行まで。残りは次の朝
 */

/** 設定から、残す日数。読めない値・0以下なら 0（移さない） */
function auditKeepDays_(settings) {
  const n = parseInt(settings['変更履歴を残す日数'], 10);
  return isFinite(n) && n > 0 ? Math.min(n, 36500) : 0;
}

/**
 * 変更履歴の「日時」の列（上から順）から、頭から続けて cutoff より前の行の数を数える。
 * @param {Array<string>} stamps 'yyyy-MM-dd HH:mm'（読めない値は ''）
 * @param {string} cutoff 'yyyy-MM-dd'。この日より前（その日は含まない）を古いとする
 * @param {number} max 数える上限
 */
function auditOldCount_(stamps, cutoff, max) {
  let n = 0;
  while (n < stamps.length && n < max) {
    const d = String(stamps[n] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= cutoff) break;
    n++;
  }
  return n;
}

/** 保管用のスプレッドシート。無ければ作る（create が false なら作らずに null） */
function auditArchiveSs_(create) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(AUDIT_ARCHIVE_PROPERTY);
  if (id) {
    try {
      const file = DriveApp.getFileById(id);
      if (!file.isTrashed()) return SpreadsheetApp.openById(id);
    } catch (e) { /* 消されていたら作り直す */ }
  }
  if (!create) return null;
  const ss = SpreadsheetApp.create(AUDIT_ARCHIVE_NAME);
  try { DriveApp.getFileById(ss.getId()).moveTo(filesFolder_()); } catch (e) { console.warn('保管用のスプレッドシートを、ファイルのフォルダーへ移せませんでした: ' + e); }
  props.setProperty(AUDIT_ARCHIVE_PROPERTY, ss.getId());
  return ss;
}

/** 保管用の、その年のシート（無ければ見出しを付けて作る） */
function auditArchiveSheet_(ss, year) {
  let sh = ss.getSheetByName(year);
  if (sh) return sh;
  const headers = SCHEMA[SHEET_AUDIT].map(function (c) { return c[0]; });
  sh = ss.insertSheet(year);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eef5');
  sh.setFrozenRows(1);
  // 最初に作られる空のシート（「シート1」など）は、年のシートができたら消す
  ss.getSheets().forEach(function (s) {
    if (!/^\d{4}$/.test(s.getName()) && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  return sh;
}

/**
 * 毎朝の処理から呼ぶ。古い変更履歴を移して、移した行数を返す。
 * @return {number}
 */
function archiveAuditLog_() {
  const days = auditKeepDays_(getSettings_());
  if (!days) return 0;
  const today = todayYmd_(), p = today.split('-');
  const cutoff = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - days), scriptTz_(), 'yyyy-MM-dd');

  return withLock_(function () {
    const head = tableHead_(SHEET_AUDIT);
    const sheet = head.sheet, headers = head.headers;
    const col = headers.indexOf('日時');
    const lastRow = sheet.getLastRow();
    if (col === -1 || lastRow < 2) return 0;
    const span = Math.min(lastRow - 1, AUDIT_ARCHIVE_MAX_ROWS);
    // まず「日時」の列だけを読んで、移す行数を決める（表を丸ごと読まない）
    const stamps = sheet.getRange(2, col + 1, span, 1).getValues().map(function (r) { return fromCell_('datetime', r[0]); });
    const n = auditOldCount_(stamps, cutoff, span);
    if (!n) return 0;

    // 移す行を読んで、保管用の見出しの順に並べ替え、年ごとに分ける
    const values = sheet.getRange(2, 1, n, headers.length).getValues();
    const want = SCHEMA[SHEET_AUDIT].map(function (c) { return headers.indexOf(c[0]); });
    const byYear = {};
    values.forEach(function (row, i) {
      const year = stamps[i].slice(0, 4);
      (byYear[year] = byYear[year] || []).push(want.map(function (j) { return j === -1 ? '' : row[j]; }));
    });

    // 先に保管用へ書く。書けなかったら、元の行は消さない（なくさないように）
    const ss = auditArchiveSs_(true);
    Object.keys(byYear).sort().forEach(function (year) {
      const rows = byYear[year];
      const sh = auditArchiveSheet_(ss, year);
      const start = sh.getLastRow() + 1;
      if (start + rows.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), start + rows.length - 1 - sh.getMaxRows() + 100);
      sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
    });
    SpreadsheetApp.flush();

    sheet.deleteRows(2, n);
    forgetRows_(SHEET_AUDIT);
    markDirty_(SHEET_AUDIT);
    logAudit_('古い変更履歴を保管', n + '件', '', '', '', cutoff + ' より前 → ' + AUDIT_ARCHIVE_NAME, '自動更新');
    return n;
  });
}

/** 保管用のスプレッドシートのURL（まだ作っていなければ ''） */
function auditArchiveUrl_() {
  try {
    const ss = auditArchiveSs_(false);
    return ss ? ss.getUrl() : '';
  } catch (e) { return ''; }
}
