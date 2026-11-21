/**
 * Report.gs … お客様向けの月次レポート
 *
 * 1顧客・1か月ぶんの「やったこと」と「いまの状態」をまとめる。画面で見て、ブラウザの印刷でPDFにする。
 * お客様に渡すものなので、備考・社内メモ・認証情報・修理の内容（社内向けの書き方になりやすい）は入れない。
 *
 * 公開関数：getMonthlyReport（お客様ページ用の getPortalReport は Portal.gs）
 */

function checkReportMonth_(month) {
  const m = String(month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw appError_('invalid', '月の指定が正しくありません。');
  if (m > todayYmd_().slice(0, 7)) throw appError_('invalid', '先の月のレポートは作れません。');
  return m;
}

function monthEnd_(month) {
  const p = month.split('-');
  const d = new Date(Number(p[0]), Number(p[1]), 0); // 翌月の0日＝その月の末日
  return month + '-' + pad2_(d.getDate());
}

/**
 * レポートの中身を作る。
 * @param {Object} customer 顧客シートの1行
 * @param {string} month 'yyyy-MM'
 */
function buildReport_(customer, month) {
  const id = String(customer['顧客ID']);
  const settings = getSettings_();
  const today = todayYmd_();
  const from = month + '-01';
  const to = monthEnd_(month);
  const mine = function (r) { return String(r['顧客ID']) === id; };
  const inMonth = function (ymd) { return !!ymd && ymd >= from && ymd <= to; };
  const asc = function (key) { return function (a, b) { return a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0; }; };

  const activities = readTable_(SHEET_ACTIVITIES).rows.filter(function (a) { return mine(a) && inMonth(a['受付日']); }).sort(asc('受付日'));
  const kinds = {};
  activities.forEach(function (a) { const k = a['対応種別'] || 'その他'; kinds[k] = (kinds[k] || 0) + 1; });

  const allRepairs = readTable_(SHEET_REPAIRS).rows.filter(mine);
  const repairs = allRepairs.filter(function (r) {
    return inMonth(r['受付日']) || inMonth(r['完了日']) || (r['ステータス'] !== REPAIR_DONE && r['受付日'] && r['受付日'] <= to);
  }).sort(asc('受付日'));

  const maintenances = readTable_(SHEET_MAINT).rows.filter(function (m) { return mine(m) && inMonth(m['実施日']); }).sort(asc('実施日'));

  const devices = readTable_(SHEET_DEVICES).rows.filter(function (d) { return mine(d) && d['状況'] !== '廃棄'; });
  const byKind = {};
  devices.forEach(function (d) { const k = d['種類'] || 'その他'; byKind[k] = (byKind[k] || 0) + 1; });

  // 収集ツールの値から、お客様に伝えたほうがよいもの
  const diag = {};
  readTable_(SHEET_DIAGNOSTICS).rows.forEach(function (g) { diag[String(g['機器ID'])] = g; });
  const eventMin = settingInt_(settings, 'イベントエラーのしきい値', 200, 99999);
  const deviceNotes = [];
  devices.forEach(function (d) {
    const g = diag[String(d['機器ID'])];
    if (!g || d['状況'] !== '使用中') return;
    // 古い受信（月末から90日より前・移行した古い値）は、お客様には出さない（v0.38.0）
    const got = String(g['受信日時'] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(got) || dayDiff_(got, to) > 90) return;
    const name = [d['利用者'], d['機種名']].filter(function (x) { return x; }).join(' / ') || String(d['種類']);
    if (/EventID/.test(String(g['ディスク関連イベント']))) deviceNotes.push({ name: name, level: 'danger', note: 'ディスクに異常の記録があります。早めの点検とバックアップをおすすめします。' });
    else if (eventMin > 0 && typeof g['イベントエラー'] === 'number' && g['イベントエラー'] >= eventMin) deviceNotes.push({ name: name, level: 'warn', note: 'エラーの記録が多くなっています（' + g['イベントエラー'] + '件）。' });
  });

  // 期限が切れた・月末から60日以内に切れるライセンス
  const licenses = readTable_(SHEET_LICENSES).rows.filter(function (l) {
    return mine(l) && l['有効期限'] && dayDiff_(to, l['有効期限']) <= 60;
  }).sort(asc('有効期限')).map(function (l) {
    return { '製品名': l['製品名'], '数量': l['数量'], '有効期限': l['有効期限'], state: l['有効期限'] < today ? '期限切れ' : '期限が近い' };
  });

  return {
    provider: settings['自社名'] || '',
    customerName: customer['顧客名'],
    month: month, from: from, to: to, createdOn: today,
    summary: {
      activities: activities.length,
      kinds: Object.keys(kinds).sort(function (a, b) { return kinds[b] - kinds[a]; }).map(function (k) { return { name: k, count: kinds[k] }; }),
      repairsReceived: allRepairs.filter(function (r) { return inMonth(r['受付日']); }).length,
      repairsDone: allRepairs.filter(function (r) { return inMonth(r['完了日']); }).length,
      maintenances: maintenances.length,
      devices: devices.length
    },
    activities: activities.map(function (a) { return pick_(a, ['受付日', '対応種別', 'インシデント種別', '内容', 'ステータス']); }),
    repairs: repairs.map(function (r) { return pick_(r, ['受付日', '完了日', '種別', '件名', 'ステータス']); }),
    maintenances: maintenances.map(function (m) { return pick_(m, ['実施日', '種別', '内容']); }),
    deviceKinds: Object.keys(byKind).sort(function (a, b) { return byKind[b] - byKind[a]; }).map(function (k) { return { name: k, count: byKind[k] }; }),
    deviceNotes: deviceNotes,
    licenses: licenses
  };
}

/**
 * 月次レポート（管理画面用）。
 * @param {{token:string, customerId:string, month:string}} params month は 'yyyy-MM'
 */
function getMonthlyReport(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const month = checkReportMonth_(p.month);
    const customer = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
    if (!customer) throw appError_('notfound', '顧客が見つかりません。');
    return { report: buildReport_(customer, month), published: reportPubOf_(customer['顧客ID'])[month] || null, portalReport: portalTabs_(customer).indexOf('レポート') !== -1 };
  });
}

// ---------------------------------------------------------------------------
// 月次レポートを、お客様ページに出す（v0.30.0）
//   設定「レポートは公開した月だけ見せる」が「はい」のとき、お客様ページに出るのは、ここで公開した月だけ。
//   公開した月と、そのときの「ひとこと」は、スクリプトのプロパティに顧客ごとに持つ（シートの列は増やさない）
// ---------------------------------------------------------------------------
// 1つの月を1つのプロパティにする（1つのプロパティは9KBまで。まとめて持つと、ひとことが長いと入らなくなるため）
function reportPubKey_(customerId, month) { return REPORT_PUB_PREFIX + String(customerId) + '_' + month; }
/** {'2026-09': {note, by, at}, …}（過去12か月の分だけ） */
function reportPubOf_(customerId) {
  const props = PropertiesService.getScriptProperties(), out = {};
  recentMonths_().forEach(function (m) {
    const raw = props.getProperty(reportPubKey_(customerId, m));
    if (!raw) return;
    try { const o = JSON.parse(raw); if (o && typeof o === 'object') out[m] = { note: String(o.note || ''), by: String(o.by || ''), at: String(o.at || '') }; } catch (e) { /* 壊れていれば出さない */ }
  });
  return out;
}
/** お客様ページで見られる月（新しい順） */
function portalReportMonths_(customer) {
  const months = recentMonths_();
  const thisMonth = todayYmd_().slice(0, 7);
  if (getSettings_()['レポートは公開した月だけ見せる'] === NO) return months.filter(function (m) { return m !== thisMonth; });
  const pub = reportPubOf_(customer['顧客ID']);
  return months.filter(function (m) { return Object.prototype.hasOwnProperty.call(pub, m); });
}

/**
 * 月次レポートを、お客様ページに出す・出すのをやめる。
 * @param {{token:string, customerId:string, month:string, publish:boolean, note:string=}} params
 */
function publishReport(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);      // お客様に見せる範囲を決めるのは、管理者だけ（「ポータル表示」と同じ）
    const month = checkReportMonth_(p.month);
    return withLock_(function () {
      const customer = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!customer) throw appError_('notfound', '顧客が見つかりません。');
      if (recentMonths_().indexOf(month) === -1) throw appError_('invalid', 'お客様ページに出せるのは、過去12か月のレポートです。');
      const id = String(customer['顧客ID']);
      const props = PropertiesService.getScriptProperties();
      // 12か月より前のものは片づける
      const keep = recentMonths_();
      Object.keys(props.getProperties()).forEach(function (k) {
        if (k.indexOf(REPORT_PUB_PREFIX + id + '_') !== 0) return;
        if (keep.indexOf(k.slice((REPORT_PUB_PREFIX + id + '_').length)) === -1) props.deleteProperty(k);
      });
      let published = null;
      if (p.publish === true) {
        published = { note: cleanText_(p.note, REPORT_NOTE_MAX), by: me.name, at: nowStamp_() };
        props.setProperty(reportPubKey_(id, month), JSON.stringify(published));
      } else props.deleteProperty(reportPubKey_(id, month));
      logAudit_(p.publish === true ? 'レポート公開' : 'レポート公開をやめる', id + ' ' + month, id, '', '', month, me.name);
      return { published: published };
    });
  });
}
