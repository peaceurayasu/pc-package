/**
 * Alerts.gs … 要対応アラートと通知メール
 *
 * 出すもの（しきい値は設定シート。0 にすると、その種類は出さない）
 *   disk     … 収集ツールがディスクの異常イベントを見つけた機器
 *   license  … 有効期限が切れた・近いライセンス
 *   repair   … 受付から日数がたっても完了していない修理
 *   activity … 受付から日数がたっても完了していない対応
 *   event    … 収集ツールのイベントエラーが多い機器
 *   stale    … 収集ツールから長く届いていない機器
 *   frequent … 保守契約のある顧客で、今月のリモート・訪問が多い
 *   spotidle … スポット保守の顧客で、月の後半になっても今月の対応が無い
 *
 * 「対応済み」にしたアラートは、状況（判定値）が変わるか、再表示日数がたつまで出さない。
 * 通知メールは、新しく出たアラートだけを毎朝1通にまとめて送る（同じアラートを毎日は送らない）。
 *
 * 公開関数：getAlerts / resolveAlert / unresolveAlert / sendAlertMailNow
 *           runDailyAlerts（時間のトリガー用）/ setupDailyTrigger / removeDailyTrigger（メニュー用）
 */

function settingInt_(settings, key, fallback, max) {
  const n = parseInt(settings[key], 10);
  return isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

/** 'yyyy-MM-dd' どうしの日数の差（b - a） */
function dayDiff_(a, b) {
  const pa = String(a).slice(0, 10).split('-'), pb = String(b).slice(0, 10).split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

/** 設定「要対応に出さない種類」を、種類のキーの並びにする（知らないキーは捨てる） */
function hiddenAlertCategories_(settings) {
  const known = ALERT_CATEGORIES.map(function (c) { return c[0]; });
  return String(settings['要対応に出さない種類'] || '').split(',').map(function (x) { return x.trim(); })
    .filter(function (x, i, all) { return known.indexOf(x) !== -1 && all.indexOf(x) === i; });
}

function alertLabel_(category) {
  for (let i = 0; i < ALERT_CATEGORIES.length; i++) if (ALERT_CATEGORIES[i][0] === category) return ALERT_CATEGORIES[i][1];
  return category;
}

function oneLine_(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * いまの状況から、出すべきアラートを全部作る（対応済みかどうかは見ない）。
 * @return {Array<Object>} {key, category, level, customerId, targetType, targetId, title, detail, sig}
 */
function computeAlerts_() {
  const ctx = alertContext_();
  let out = [];
  ALERT_PART_NAMES.forEach(function (name) { out = out.concat(alertSources_()[name](ctx)); });
  return finishAlerts_(out, ctx.settings);
}

// 要対応は、もとになるシートごとに5つに分けて作る（サーバー側の控えも、この単位で持つ。
// たとえば対応を1件足したときは「対応から」のぶんだけ作り直せばよく、機器診断などを読み直さずに済む）
const ALERT_PART_NAMES = ['alertsLicense', 'alertsRental', 'alertsDevice', 'alertsRepair', 'alertsActivity'];

function alertSources_() {
  return {
    alertsLicense: alertsLicense_, alertsRental: alertsRental_, alertsDevice: alertsDevice_,
    alertsRepair: alertsRepair_, alertsActivity: alertsActivity_
  };
}

/** 要対応を作るときに、どの種類でも使うもの（設定・今日の日付・顧客） */
function alertContext_() {
  const settings = getSettings_();
  const today = todayYmd_();
  const customers = {};
  readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { customers[String(c['顧客ID'])] = c; });
  return {
    settings: settings, today: today, month: today.slice(0, 7), customers: customers,
    live: function (customerId) {
      const c = customers[String(customerId)];
      return !!c && c['状態'] === '有効';
    }
  };
}

function alertPusher_(out) {
  return function (category, targetType, targetId, customerId, level, title, detail, sig) {
    out.push({
      key: category + ':' + targetId, category: category, level: level, customerId: String(customerId),
      targetType: targetType, targetId: String(targetId), title: title, detail: detail || '', sig: String(sig)
    });
  };
}

/** ライセンス期限 */
function alertsLicense_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, live = ctx.live;
  const licenseDays = settingInt_(settings, 'ライセンス期限の手前日数', 30, 3650);
  readTable_(SHEET_LICENSES).rows.forEach(function (l) {
    if (!l['有効期限'] || !live(l['顧客ID'])) return;
    const d = dayDiff_(today, l['有効期限']);
    if (d < 0) push('license', 'license', l['ライセンスID'], l['顧客ID'], 'danger', l['製品名'], '期限切れ（' + l['有効期限'] + '）', l['有効期限'] + '|切れ');
    else if (d <= licenseDays) push('license', 'license', l['ライセンスID'], l['顧客ID'], 'warn', l['製品名'], 'あと' + d + '日（' + l['有効期限'] + '）', l['有効期限'] + '|近い');
  });
  return out;
}

/** レンタルの返却 */
function alertsRental_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, customers = ctx.customers;
  if (settings['レンタル機器を使う'] !== NO) {
    const soon = settingInt_(settings, 'レンタル返却の手前日数', 3, 3650);
    const rentals = {};
    readTable_(SHEET_RENTALS).rows.forEach(function (r) { rentals[String(r['レンタルID'])] = r; });
    readTable_(SHEET_LOANS).rows.forEach(function (l) {
      if (l['返却日'] || !l['返却予定日']) return;
      const d = dayDiff_(today, l['返却予定日']);
      if (d > soon) return;
      const r = rentals[String(l['レンタルID'])];
      const who = l['貸出先'] ? '貸出先 ' + l['貸出先'] + '・' : '';
      const cid = customers[String(l['顧客ID'])] ? l['顧客ID'] : '';
      if (d < 0) push('rental', 'loan', l['貸出ID'], cid, 'danger', r ? r['名称'] : l['レンタルID'], who + '返却予定を' + (-d) + '日過ぎている（' + l['返却予定日'] + '）', l['返却予定日'] + '|超過');
      else push('rental', 'loan', l['貸出ID'], cid, 'warn', r ? r['名称'] : l['レンタルID'], who + '返却予定まであと' + d + '日（' + l['返却予定日'] + '）', l['返却予定日'] + '|近い');
    });
  }
  return out;
}

/** 収集ツールの値から（使用中の機器だけ） */
function alertsDevice_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, live = ctx.live;
  const eventMin = settingInt_(settings, 'イベントエラーのしきい値', 200, 99999);
  const staleDays = settingInt_(settings, '収集ツール未受信の日数', 45, 3650);
  const diskOn = settings['ディスク異常を出す'] !== NO;
  const diag = {};
  // 機器診断は、重い列（イベントの中身・プリンター情報など）を読まない
  readTable_(SHEET_DIAGNOSTICS, DIAG_LEAN_SKIP).rows.forEach(function (g) { diag[String(g['機器ID'])] = g; });
  readTable_(SHEET_DEVICES).rows.forEach(function (dev) {
    const g = diag[String(dev['機器ID'])];
    if (!g || dev['状況'] !== '使用中' || !live(dev['顧客ID'])) return;
    const name = [dev['利用者'], dev['機種名']].filter(function (x) { return x; }).join(' / ') || g['コンピューター名'] || String(dev['機器ID']);
    const received = String(g['受信日時']).slice(0, 10);
    // ツールは、異常があるときだけ「■ EventID …」の形で送ってくる（無いときは「なし」など）
    if (diskOn && /EventID/.test(String(g['ディスク関連イベント']))) {
      push('disk', 'device', dev['機器ID'], dev['顧客ID'], 'danger', name, oneLine_(g['ディスク関連イベント'], 80), received);
    }
    if (eventMin > 0 && typeof g['イベントエラー'] === 'number' && g['イベントエラー'] >= eventMin) {
      push('event', 'device', dev['機器ID'], dev['顧客ID'], 'warn', name, 'エラー ' + g['イベントエラー'] + '件（' + received + ' 受信）', '');
    }
    if (staleDays > 0 && received) {
      const idle = dayDiff_(received, today);
      if (idle >= staleDays) push('stale', 'device', dev['機器ID'], dev['顧客ID'], 'warn', name, idle + '日届いていない（最後は ' + received + '）', received);
    }
  });
  return out;
}

/** 修理の長期化 */
function alertsRepair_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, live = ctx.live;
  const repairDays = settingInt_(settings, '修理の長期化の日数', 7, 3650);
  if (repairDays > 0) {
    readTable_(SHEET_REPAIRS).rows.forEach(function (r) {
      if (r['ステータス'] === REPAIR_DONE || !r['受付日'] || !live(r['顧客ID'])) return;
      const age = dayDiff_(r['受付日'], today);
      if (age >= repairDays) push('repair', 'repair', r['修理ID'], r['顧客ID'], 'warn', r['件名'], r['ステータス'] + 'のまま' + age + '日（受付 ' + r['受付日'] + '）', r['ステータス']);
    });
  }
  return out;
}

/** 対応の保留と、今月の対応の数から */
function alertsActivity_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, live = ctx.live, customers = ctx.customers, month = ctx.month;
  const activityDays = settingInt_(settings, '対応の保留の日数', 7, 3650);
  const activities = readTable_(SHEET_ACTIVITIES).rows;
  if (activityDays > 0) {
    activities.forEach(function (a) {
      if (a['ステータス'] === ACTIVITY_DONE || !a['受付日'] || !live(a['顧客ID'])) return;
      const age = dayDiff_(a['受付日'], today);
      if (age >= activityDays) push('activity', 'activity', a['対応ID'], a['顧客ID'], 'warn', oneLine_(a['内容'], 40), a['ステータス'] + 'のまま' + age + '日（受付 ' + a['受付日'] + '）', a['ステータス']);
    });
  }

  // 今月の対応の数から
  const remoteMin = settingInt_(settings, 'リモート多発の回数', 5, 99999);
  const visitMin = settingInt_(settings, '訪問多発の回数', 10, 99999);
  const spotDay = settingInt_(settings, 'スポット保守の確認日', 20, 31);
  const counts = {};
  activities.forEach(function (a) {
    if (String(a['受付日']).slice(0, 7) !== month) return;
    const id = String(a['顧客ID']);
    const c = counts[id] = counts[id] || { total: 0, remote: 0, visit: 0 };
    c.total++;
    if (a['対応種別'] === ACTIVITY_KIND_REMOTE) c.remote++;
    if (a['対応種別'] === ACTIVITY_KIND_VISIT) c.visit++;
  });
  const dayOfMonth = Number(today.slice(8, 10));
  Object.keys(customers).forEach(function (id) {
    const c = customers[id];
    if (c['状態'] !== '有効') return;
    const n = counts[id] || { total: 0, remote: 0, visit: 0 };
    if (c['保守契約'] === '定期保守' || c['保守契約'] === 'スポット保守') {
      const parts = [];
      if (remoteMin > 0 && n.remote >= remoteMin) parts.push(ACTIVITY_KIND_REMOTE + ' ' + n.remote + '回');
      if (visitMin > 0 && n.visit >= visitMin) parts.push(ACTIVITY_KIND_VISIT + ' ' + n.visit + '回');
      if (parts.length) push('frequent', 'customer', id, id, 'warn', '今月の対応が多い', parts.join('・') + '（' + c['保守契約'] + '）', month);
    }
    if (c['保守契約'] === 'スポット保守' && spotDay > 0 && dayOfMonth >= spotDay && n.total === 0) {
      push('spotidle', 'customer', id, id, 'warn', '今月の対応がまだ無い', month + '（スポット保守）', month);
    }
  });
  return out;
}

/** 設定で「出さない」にした種類を外して、並べる（画面・件数・通知メールのどれにも出ない） */
function finishAlerts_(list, settings) {
  const hidden = hiddenAlertCategories_(settings);
  const out = list.filter(function (a) { return hidden.indexOf(a.category) === -1; });
  const order = {};
  ALERT_CATEGORIES.forEach(function (c, i) { order[c[0]] = i; });
  out.sort(function (a, b) {
    return (a.level === b.level ? 0 : a.level === 'danger' ? -1 : 1) || (order[a.category] - order[b.category]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  return out;
}

function alertStates_() {
  const map = {};
  readTable_(SHEET_ALERTS).rows.forEach(function (r) { map[String(r['キー'])] = r; });
  return map;
}

/** 「対応済み」にしてあって、まだ出し直す時期でないか */
function isAlertResolved_(alert, state, settings, today) {
  if (!state || !state['対応済み日時'] || String(state['判定値']) !== alert.sig) return false;
  const again = settingInt_(settings, 'アラートの再表示日数', 30, 3650);
  return again === 0 || dayDiff_(state['対応済み日時'], today) < again;
}

/** 画面に渡す形（判定値は渡さない） */
function alertsForClient_() {
  return alertsToClient_(computeAlerts_(), alertStates_(), getSettings_(), todayYmd_());
}

function alertsToClient_(alerts, states, settings, today) {
  return alerts.map(function (a) {
    const st = states[a.key];
    const resolved = isAlertResolved_(a, st, settings, today);
    return {
      key: a.key, category: a.category, label: alertLabel_(a.category), level: a.level, customerId: a.customerId,
      targetType: a.targetType, targetId: a.targetId, title: a.title, detail: a.detail,
      resolved: resolved, resolvedAt: resolved ? st['対応済み日時'] : '', resolvedBy: resolved ? st['対応者'] : ''
    };
  });
}

/** 控えに入れる形の「対応済み」の状態（行番号は入れない） */
function alertStatesForCache_() {
  const map = {};
  readTable_(SHEET_ALERTS).rows.forEach(function (r) {
    map[String(r['キー'])] = { '判定値': r['判定値'], '対応済み日時': r['対応済み日時'], '対応者': r['対応者'] };
  });
  return map;
}

/**
 * 画面に渡す要対応を、部品（控え）から組み立てる。中身は alertsForClient_() と同じ。
 * @param {Object} parts ALERT_PART_NAMES の5つと alertStates が入ったもの
 */
function alertsFromParts_(parts) {
  const settings = getSettings_();
  let raw = [];
  ALERT_PART_NAMES.forEach(function (name) { raw = raw.concat(parts[name] || []); });
  return alertsToClient_(finishAlerts_(raw, settings), parts.alertStates || {}, settings, todayYmd_());
}

// ---------------------------------------------------------------------------
// 公開関数：画面から
// ---------------------------------------------------------------------------
/** いまの要対応アラート。@param {{token:string}} params */
function getAlerts(params) {
  return api_(function () {
    cachePrime_();
    requireSession_(params && params.token);
    return { alerts: alertsFromParts_(bootParts_(ALERT_PART_NAMES.concat(['alertStates']))) };
  });
}

/**
 * アラートを「対応済み」にする。
 * @param {{token:string, key:string}} params
 */
function resolveAlert(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const alert = computeAlerts_().filter(function (a) { return a.key === String(p.key); })[0];
      if (!alert) throw appError_('notfound', 'そのアラートは、もう出ていません。');
      const now = nowStamp_();
      const state = alertStates_()[alert.key];
      if (state) {
        updateRecord_(SHEET_ALERTS, state._row, { '判定値': alert.sig, '対応済み日時': now, '対応者': me.name });
      } else {
        appendRecord_(SHEET_ALERTS, {
          'キー': alert.key, 'カテゴリ': alert.category, '顧客ID': alert.customerId, '対象ID': alert.targetId,
          '判定値': alert.sig, '初回検知日時': now, '対応済み日時': now, '対応者': me.name
        });
      }
      logAudit_('アラート対応済み', alert.key, alert.customerId, alertLabel_(alert.category), '', alert.title + ' ' + alert.detail, me.name);
      return { alerts: alertsForClient_() };
    });
  });
}

/**
 * 「対応済み」を取り消す。
 * @param {{token:string, key:string}} params
 */
function unresolveAlert(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const state = alertStates_()[String(p.key)];
      if (!state || !state['対応済み日時']) throw appError_('notfound', 'そのアラートは、対応済みになっていません。');
      updateRecord_(SHEET_ALERTS, state._row, { '対応済み日時': '', '対応者': '' });
      logAudit_('アラート対応済みの取り消し', state['キー'], state['顧客ID'], alertLabel_(state['カテゴリ']), '', '', me.name);
      return { alerts: alertsForClient_() };
    });
  });
}

// ---------------------------------------------------------------------------
// 通知メール
// ---------------------------------------------------------------------------
function alertRecipients_(settings) {
  return String(settings['通知先メール'] || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

/** 通知メールの件名と本文を作る。fresh は新しく出たもの、openCount はいま出ている全部の数 */
function buildAlertMail_(settings, fresh, openCount, isTest) {
  const customers = {};
  readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { customers[String(c['顧客ID'])] = c['顧客名']; });
  const company = settings['自社名'] ? settings['自社名'] + ' ' : '';
  const subject = '【' + company + APP_NAME + '】要対応 ' + (isTest ? fresh.length + '件（送信テスト）' : '新着' + fresh.length + '件') +
    (!isTest && openCount > fresh.length ? '（ほかに継続' + (openCount - fresh.length) + '件）' : '');
  const lines = [isTest ? 'いま出ている要対応の一覧です（送信テスト）。' : '新しく出た要対応のお知らせです。', ''];
  let used = 0;
  ALERT_CATEGORIES.forEach(function (cat) {
    const items = fresh.filter(function (a) { return a.category === cat[0]; });
    if (!items.length) return;
    lines.push('■ ' + cat[1] + '（' + items.length + '件）');
    items.forEach(function (a) {
      if (used >= ALERT_MAIL_MAX_LINES) return;
      used++;
      const who = customers[a.customerId] || a.customerId;
      lines.push('・' + (who ? who + '：' : '') + a.title + (a.detail ? ' ― ' + a.detail : ''));
    });
    lines.push('');
  });
  if (fresh.length > used) lines.push('…ほか ' + (fresh.length - used) + ' 件は管理画面で確認してください。', '');
  if (!isTest && openCount > fresh.length) lines.push('このほかに、前からの要対応が ' + (openCount - fresh.length) + ' 件あります。', '');
  const url = webAppUrl_();
  if (url) lines.push('管理画面：' + url);
  lines.push('', 'このメールは ' + APP_NAME + ' から自動で送っています。');
  return { subject: subject, body: lines.join('\n') };
}

/**
 * 毎朝の処理の本体。アラート状態シートをいまの状況に合わせ、新しく出たものがあればメールを送る。
 * @return {{fresh:number, open:number, sent:boolean}}
 */
function dailyAlertsCore_() {
  return withLock_(function () {
    const settings = getSettings_();
    const today = todayYmd_();
    const now = nowStamp_();
    const alerts = computeAlerts_();
    const states = alertStates_();
    const active = {};
    alerts.forEach(function (a) { active[a.key] = a; });

    // もう出ていないアラートの行は消す（次に同じものが出たら「新着」として扱うため）。下の行から消す
    // 設定で「出さない」にしている種類の行は残す（また出すようにしたとき、対応済み・通知済みを覚えているように）
    const hidden = hiddenAlertCategories_(getSettings_());
    Object.keys(states)
      .filter(function (key) { return !active[key] && hidden.indexOf(String(key).split(':')[0]) === -1; })
      .map(function (key) { return states[key]._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (rowNumber) { deleteRecord_(SHEET_ALERTS, rowNumber); });

    // 状況が変わったものは、通知と対応済みを取り消して「新着」に戻す
    const fresh = [];
    const toAppend = [];
    const current = alertStates_();
    alerts.forEach(function (a) {
      const st = current[a.key];
      if (!st) {
        toAppend.push({ 'キー': a.key, 'カテゴリ': a.category, '顧客ID': a.customerId, '対象ID': a.targetId, '判定値': a.sig, '初回検知日時': now });
        fresh.push(a);
      } else if (String(st['判定値']) !== a.sig) {
        updateRecord_(SHEET_ALERTS, st._row, { '判定値': a.sig, '初回検知日時': now, '通知日時': '', '対応済み日時': '', '対応者': '' });
        fresh.push(a);
      } else if (!st['通知日時'] && !isAlertResolved_(a, st, settings, today)) {
        fresh.push(a);
      }
    });
    appendRecords_(SHEET_ALERTS, toAppend);

    const latest = alertStates_();
    const open = alerts.filter(function (a) { return !isAlertResolved_(a, latest[a.key], settings, today); });
    const recipients = alertRecipients_(settings);
    let sent = false;
    if (fresh.length && recipients.length) {
      const mail = buildAlertMail_(settings, fresh, open.length, false);
      MailApp.sendEmail(recipients.join(','), mail.subject, mail.body);
      sent = true;
      // 送れたものだけ「通知した」にする（送信で失敗したら、次の朝にもう一度送る）
      fresh.forEach(function (a) {
        const st = latest[a.key];
        if (st) updateRecord_(SHEET_ALERTS, st._row, { '通知日時': now });
      });
    }
    return { fresh: fresh.length, open: open.length, sent: sent };
  });
}

/** この関数を呼ぶ時間のトリガーが、実際に入っているか */
function dailyTriggerOn_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === ALERT_TRIGGER_FUNCTION; });
}

/**
 * 時間のトリガーから呼ばれる。
 * この関数は画面（google.script.run）からも呼べてしまうので、実在するトリガーの番号が付いていない呼び出しは何もしない。
 */
function runDailyAlerts(e) {
  const uid = e && typeof e.triggerUid === 'string' ? e.triggerUid : '';
  const real = !!uid && ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === ALERT_TRIGGER_FUNCTION && String(t.getUniqueId()) === uid;
  });
  if (!real) return;
  if (!isSetupDone_()) return;
  try {
    dailyAlertsCore_();
  } catch (err) {
    console.error('毎朝のアラート処理でエラー: ' + (err && err.stack ? err.stack : err));
  }
  // 配信フォルダーも、ここで確かめる（だれも画面を開かない日でも、取り込まれるように）
  try {
    refreshFeedCore_(true);
  } catch (err) {
    console.error('配信フォルダーの確認でエラー: ' + (err && err.stack ? err.stack : err));
  }
  // 古い変更履歴を、保管用のスプレッドシートへ移す（v0.40.0）
  try {
    archiveAuditLog_();
  } catch (err) {
    console.error('古い変更履歴の保管でエラー: ' + (err && err.stack ? err.stack : err));
  }
  // 古い Windows情報を片づける（v0.34.0）
  try {
    tidyWinInfo_();
  } catch (err) {
    console.error('古いWindows情報の片づけでエラー: ' + (err && err.stack ? err.stack : err));
  }
}

/**
 * いま出ている要対応を、通知先にメールで送ってみる（管理者）。通知済みの印は付けない。
 * @param {{token:string}} params
 */
function sendAlertMailNow(params) {
  return api_(function () {
    requireSession_(params && params.token, true);
    const settings = getSettings_();
    const recipients = alertRecipients_(settings);
    if (!recipients.length) throw appError_('invalid', '「通知先メール」が入っていません。先に保存してください。');
    const today = todayYmd_();
    const states = alertStates_();
    const open = computeAlerts_().filter(function (a) { return !isAlertResolved_(a, states[a.key], settings, today); });
    const mail = buildAlertMail_(settings, open, open.length, true);
    try {
      MailApp.sendEmail(recipients.join(','), mail.subject, mail.body);
    } catch (err) {
      console.error('通知メールの送信に失敗: ' + err);
      throw appError_('mail', 'メールを送れませんでした。1日に送れる数を超えたか、メールを送る許可がまだ出ていない可能性があります。スプレッドシートのメニューから「毎朝の通知を設定」を一度実行してください。');
    }
    return { count: open.length, to: recipients.length };
  });
}

// ---------------------------------------------------------------------------
// メニュー：毎朝の通知
// ---------------------------------------------------------------------------
function deleteDailyTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === ALERT_TRIGGER_FUNCTION) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/** メニュー：毎朝の通知を設定する（設定し直すときも同じ） */
function setupDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const settings = getSettings_();
  const hour = settingInt_(settings, '通知の時刻', 8, 23);
  deleteDailyTriggers_();
  ScriptApp.newTrigger(ALERT_TRIGGER_FUNCTION).timeBased().everyDays(1).atHour(hour).create();
  // メールを送る許可をここで求めておく（許可が無いと、朝の送信が失敗する）
  MailApp.getRemainingDailyQuota();
  const to = alertRecipients_(settings);
  ui.alert('毎朝 ' + hour + ' 時台に、要対応の確認と通知を行うようにしました。\n\n' +
    (to.length ? '通知先：' + to.join('、') : '通知先メールがまだ入っていません。管理画面の「設定」で入れてください（入れるまでメールは送りません）。'));
}

/** メニュー：毎朝の通知をやめる */
function removeDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  const n = deleteDailyTriggers_();
  ui.alert(n ? '毎朝の通知をやめました。' : '毎朝の通知は設定されていません。');
}

// ---------------------------------------------------------------------------
// GAS を起こしておく（v0.21.0）
//   時間のトリガーで30分ごとに呼ぶ。WARM_FROM_HOUR〜WARM_TO_HOUR の間だけ、画面に渡すデータの控え（キャッシュ）を作っておく。
//   控えは1時間で切れるので、だれも使わない時間が続いたあとでも、ログインがすぐ終わる（シートを読まずに済む）。
//   それ以外の時間は、時刻を見てすぐ終わる（ほとんど時間を使わない）。
// ---------------------------------------------------------------------------
function warmTriggerOn_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === WARM_TRIGGER_FUNCTION; });
}

/** 控えを作っておく（だれのログインでもない。画面に渡す部品だけ） */
function warmUpCore_() {
  cachePrime_();
  bootParts_(['customers', 'devices', 'diagnostics', 'licenses', 'allocations', 'repairs', 'activities', 'maintenances', 'memos', 'notices',
    'rentals', 'loans', 'photoCounts', 'wininfo', 'alertStates'].concat(ALERT_PART_NAMES));
  refPart_('refSettings'); refPart_('refOptions'); refPart_('refStaff');
}

/**
 * 時間のトリガーから呼ばれる。画面（google.script.run）からも呼べてしまうので、実在するトリガーの番号が付いていない呼び出しは何もしない。
 */
function runWarmUp(e) {
  const uid = e && typeof e.triggerUid === 'string' ? e.triggerUid : '';
  if (!uid) return;
  const hour = Number(Utilities.formatDate(new Date(), scriptTz_(), 'H'));
  if (hour < WARM_FROM_HOUR || hour >= WARM_TO_HOUR) return;       // 時間の外は、すぐ終わる
  const real = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === WARM_TRIGGER_FUNCTION && String(t.getUniqueId()) === uid;
  });
  if (!real || !isSetupDone_()) return;
  try { warmUpCore_(); } catch (err) { console.warn('起こしておく処理でエラー: ' + (err && err.stack ? err.stack : err)); }
}

function deleteWarmTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WARM_TRIGGER_FUNCTION) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/** メニュー：起こしておくのを設定する（設定し直すときも同じ） */
function setupWarmTrigger() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  deleteWarmTriggers_();
  ScriptApp.newTrigger(WARM_TRIGGER_FUNCTION).timeBased().everyMinutes(WARM_EVERY_MINUTES).create();
  try { warmUpCore_(); } catch (err) { console.warn('起こしておく処理でエラー: ' + err); }
  ui.alert('毎日 ' + WARM_FROM_HOUR + '時台〜' + (WARM_TO_HOUR - 1) + '時台のあいだ、' + WARM_EVERY_MINUTES + '分ごとに、画面のデータの控えを作っておくようにしました。\n\n' +
    'しばらくだれも使わなかったあとでも、ログインが速くなります。時間を変えたいときは、Config.gs の WARM_FROM_HOUR／WARM_TO_HOUR。');
}

/** メニュー：起こしておくのをやめる */
function removeWarmTrigger() {
  const ui = SpreadsheetApp.getUi();
  const n = deleteWarmTriggers_();
  ui.alert(n ? '起こしておくのをやめました。' : '起こしておく設定は入っていません。');
}
