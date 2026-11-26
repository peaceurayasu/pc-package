/**
 * Alerts.gs … 要対応アラートと通知メール
 *
 * 出すもの（しきい値は設定シート。0 にすると、その種類は出さない）
 *   pending  … 仮受付（トークンなしで届いて、顧客がまだ決まっていない機器）
 *   disk     … 収集ツールがディスクの異常イベントを見つけた機器
 *   license  … 有効期限が切れた・近いライセンス
 *   eset     … 機器の「ESET」列の期限が切れた・近い使用中の機器（v0.98.0）
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
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Alerts.gs'] = '0.141.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

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
 * 今の状況から、出すべきアラートを全部作る（対応済みかどうかは見ない）。
 * @return {Array<Object>} {key, category, level, customerId, targetType, targetId, title, detail, sig}
 */
function computeAlerts_() {
  const ctx = alertContext_();
  let out = [];
  ALERT_PART_NAMES.forEach(function (name) { out = out.concat(alertSources_()[name](ctx)); });
  return finishAlerts_(out, ctx.settings);
}

// 要対応は、もとになるシートごとに5つに分けて作る（サーバー側の控えも、この単位で持つ。
// たとえば対応を1件足した時は「対応から」のぶんだけ作り直せばよく、機器診断などを読み直さずに済む）
const ALERT_PART_NAMES = ['alertsLicense', 'alertsRental', 'alertsDevice', 'alertsRepair', 'alertsActivity', 'alertsBiz'];

function alertSources_() {
  return {
    alertsLicense: alertsLicense_, alertsRental: alertsRental_, alertsDevice: alertsDevice_,
    alertsRepair: alertsRepair_, alertsActivity: alertsActivity_, alertsBiz: alertsBiz_
  };
}

/** 要対応を作る時に、どの種類でも使うもの（設定・今日の日付・顧客） */
function alertContext_() {
  const settings = getSettings_();
  const today = todayYmd_();
  const customers = {};
  readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { customers[String(c['顧客ID'])] = c; });
  return {
    settings: settings, today: today, month: today.slice(0, 7), customers: customers,
    live: function (customerId) {
      const c = customers[String(customerId)];
      return !!c && c['状態'] === '有効' && c['顧客名'] !== PENDING_CUSTOMER_NAME;      // 仮受付の置き場は、要対応に出さない
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

/** ライセンス期限（v0.123.0：保守契約の更新日も、ここで出す。顧客シートの変更でも作り直される） */
function alertsLicense_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, live = ctx.live;
  const renewDays = settingInt_(settings, '契約更新のお知らせ（日前）', 60, 3650);
  Object.keys(ctx.customers).forEach(function (id) {
    const c = ctx.customers[id], due = String(c['契約更新日'] || '');
    if (!due || !live(id) || c['保守契約'] === 'なし') return;
    const d = dayDiff_(today, due);
    if (d < -30 || d > renewDays) return;          // 過ぎて1か月たったら出さない（更新日を直すのを忘れた時のため、少しだけ残す）
    push('renewal', 'customer', id, id, d < 0 ? 'danger' : 'warn', '保守契約の更新',
      (d < 0 ? '更新日をすぎています（' + due + '）。更新したら「契約更新日」を次の年に直してください' : '更新日まであと' + d + '日（' + due + '）。保守のご報告書を作ってお持ちしましょう'), due);
  });
  const licenseDays = settingInt_(settings, 'ライセンス期限の手前日数', 30, 3650);
  readTable_(SHEET_LICENSES).rows.forEach(function (l) {
    if (!l['有効期限'] || l['不使用'] === YES || !live(l['顧客ID'])) return;
    const d = dayDiff_(today, l['有効期限']);
    if (d < 0) push('license', 'license', l['ライセンスID'], l['顧客ID'], 'danger', l['製品名'], '期限切れ（' + l['有効期限'] + '）', l['有効期限'] + '|切れ');
    else if (d <= licenseDays) push('license', 'license', l['ライセンスID'], l['顧客ID'], 'warn', l['製品名'], 'あと' + d + '日（' + l['有効期限'] + '）', l['有効期限'] + '|近い');
  });
  // ESET の期限（機器の「ESET」に日付が入っている使用中の機器。手前日数はライセンスと同じ。v0.98.0）
  readTable_(SHEET_DEVICES).rows.forEach(function (dev) {
    if (dev['状況'] !== '使用中' || !live(dev['顧客ID'])) return;
    const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(dev['ESET'] || '').trim());
    if (!m) return;                                   // 日付でない値（メモなど）は見ない
    const exp = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    const d = dayDiff_(today, exp);
    const name = [dev['利用者'], dev['機種名']].filter(function (x) { return x; }).join(' / ') || String(dev['機器ID']);
    if (d < 0) push('eset', 'device', dev['機器ID'], dev['顧客ID'], 'danger', name, 'ESETの期限切れ（' + exp + '）', exp + '|切れ');
    else if (d <= licenseDays) push('eset', 'device', dev['機器ID'], dev['顧客ID'], 'warn', name, 'ESETの期限まであと' + d + '日（' + exp + '）', exp + '|近い');
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
      const who = l['貸出先'] ? '現場名 ' + l['貸出先'] + '・' : '';
      const cid = customers[String(l['顧客ID'])] ? l['顧客ID'] : '';
      if (d < 0) push('rental', 'loan', l['貸出ID'], cid, 'danger', r ? r['名称'] : l['レンタルID'], who + '返却予定を' + (-d) + '日過ぎている（' + l['返却予定日'] + '）', l['返却予定日'] + '|超過');
      else push('rental', 'loan', l['貸出ID'], cid, 'warn', r ? r['名称'] : l['レンタルID'], who + '返却予定まであと' + d + '日（' + l['返却予定日'] + '）', l['返却予定日'] + '|近い');
    });
  }
  return out;
}

/** 案件の納期・次の連絡日・営業の次回アクション（テスト版。v0.81.0 → v0.82.0 で案件に統合） */
function alertsBiz_(ctx) {
  const out = [], push = alertPusher_(out), settings = ctx.settings, today = ctx.today, customers = ctx.customers;
  if (settings['営業・案件ツール（テスト版）を使う'] === NO) return out;
  const soon = settingInt_(settings, '案件の納期の手前日数', 7, 3650);
  const cidOf = function (id) { return customers[String(id)] ? String(id) : ''; };
  const liveOf = function (id) { return !id || ctx.live(id); };
  readTable_(SHEET_PROJECTS).rows.forEach(function (r) {
    if (!liveOf(r['顧客ID'])) return;
    const st = r['状態'];
    // 納期：開発の途中（足した状態も含む）。営業の段階・納品後・保留・失注は出さない
    if (r['納期'] && (PROJECT_ACTIVE.indexOf(st) !== -1 || PROJECT_STATES.indexOf(st) === -1)) {
      const d = dayDiff_(today, r['納期']);
      if (d <= soon) {
        if (d < 0) push('project', 'project', r['案件ID'], cidOf(r['顧客ID']), 'danger', r['案件名'], '納期を' + (-d) + '日過ぎている（' + r['納期'] + '・' + st + '）', r['納期'] + '|' + st + '|切れ');
        else push('project', 'project', r['案件ID'], cidOf(r['顧客ID']), 'warn', r['案件名'], '納期まであと' + d + '日（' + r['納期'] + '・' + st + '）', r['納期'] + '|' + st + '|近い');
      }
    }
    // 次の連絡日：営業の段階だけ（今日と、過ぎたもの）
    if (r['次の連絡日'] && PROJECT_SALES.indexOf(st) !== -1) {
      const d2 = dayDiff_(today, r['次の連絡日']);
      if (d2 > 0) return;
      const who = r['担当'] ? '担当 ' + r['担当'] + '・' : '';
      const name = r['先方名'] || r['案件名'];
      if (d2 < 0) push('project', 'project', r['案件ID'], cidOf(r['顧客ID']), 'danger', name, who + '連絡の予定を' + (-d2) + '日過ぎている（' + r['次の連絡日'] + '・' + st + '）', r['次の連絡日'] + '|' + st + '|連絡切れ');
      else push('project', 'project', r['案件ID'], cidOf(r['顧客ID']), 'warn', name, who + '今日が連絡の予定（' + st + '）', r['次の連絡日'] + '|' + st + '|連絡今日');
    }
  });
  readTable_(SHEET_SALESLOGS).rows.forEach(function (r) {
    if (!r['次回予定日'] || r['アクション完了'] === YES || !(r['次回アクション'] || r['内容'])) return;
    const d = dayDiff_(today, r['次回予定日']);
    if (d > 0) return;
    const who = r['担当'] ? '担当 ' + r['担当'] + '・' : '';
    const title = oneLine_(r['次回アクション'] || r['内容'], 40);
    const target = (r['相手先'] ? r['相手先'] + '・' : '');
    if (d < 0) push('sales', 'saleslog', r['営業ID'], cidOf(r['顧客ID']), 'danger', title, who + target + '予定を' + (-d) + '日過ぎている（' + r['次回予定日'] + '）', r['次回予定日'] + '|切れ');
    else push('sales', 'saleslog', r['営業ID'], cidOf(r['顧客ID']), 'warn', title, who + target + '今日が予定', r['次回予定日'] + '|今日');
  });
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
    // 仮受付（トークンなしで届いた機器）：顧客がまだ決まっていないので、「仮受付（未割り当て）」のグループとして出す（v0.56.0）
    const owner = ctx.customers[String(dev['顧客ID'])];
    if (owner && owner['顧客名'] === PENDING_CUSTOMER_NAME) {
      if (dev['状況'] === '廃棄') return;
      const pname = [dev['利用者'], dev['機種名']].filter(function (x) { return x; }).join(' / ') || (g && g['コンピューター名']) || String(dev['機器ID']);
      push('pending', 'device', dev['機器ID'], dev['顧客ID'], 'warn', pname, '顧客がまだ決まっていません。押して、顧客を選んでください', '');
      return;
    }
    if (!g || dev['状況'] !== '使用中' || !live(dev['顧客ID'])) return;
    const name = [dev['利用者'], dev['機種名']].filter(function (x) { return x; }).join(' / ') || g['コンピューター名'] || String(dev['機器ID']);
    const received = String(g['受信日時']).slice(0, 10);
    // ツールは、異常がある時だけ「■ EventID …」の形で送ってくる（無い時は「なし」など）
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
    if (c['状態'] !== '有効' || c['顧客名'] === PENDING_CUSTOMER_NAME) return;
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
/** 今の要対応アラート。@param {{token:string}} params */
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

/** 通知メールの件名と本文を作る。fresh は新しく出たもの、openCount は今出ている全部の数 */
function buildAlertMail_(settings, fresh, openCount, isTest) {
  const customers = {};
  readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { customers[String(c['顧客ID'])] = c['顧客名']; });
  const company = settings['自社名'] ? settings['自社名'] + ' ' : '';
  const subject = '【' + company + APP_NAME + '】要対応 ' + (isTest ? fresh.length + '件（送信テスト）' : '新着' + fresh.length + '件') +
    (!isTest && openCount > fresh.length ? '（他に継続' + (openCount - fresh.length) + '件）' : '');
  const lines = [isTest ? '今出ている要対応の一覧です（送信テスト）。' : '新しく出た要対応のお知らせです。', ''];
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
  const url = siteUrl_();
  if (url) lines.push('管理画面：' + url);
  lines.push('', 'このメールは ' + APP_NAME + ' から自動で送っています。');
  return { subject: subject, body: lines.join('\n') };
}

/**
 * 毎朝の処理の本体。アラート状態シートを今の状況に合わせ、新しく出たものがあればメールを送る。
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
    // 設定で「出さない」にしている種類の行は残す（また出すようにした時、対応済み・通知済みを覚えているように）
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
  // RSS も、ここで確かめる（誰も画面を開かない日でも、取り込まれるように）。
  // 前の版で「毎朝の通知」を設定したままの人は、1時間ごとの RSS のトリガーが無いので、ここで足す（v0.113.0）
  try { ensureFeedTrigger_(); } catch (err) { console.warn('RSS のトリガーを足せませんでした: ' + err); }
  try {
    refreshFeedCore_(true);
  } catch (err) {
    console.error('自動更新（RSS）の確認でエラー: ' + (err && err.stack ? err.stack : err));
  }
  // 古い Windows情報を片づける（v0.34.0）
  try {
    tidyWinInfo_();
  } catch (err) {
    console.error('古いWindows情報の片づけでエラー: ' + (err && err.stack ? err.stack : err));
  }
}

/**
 * 今出ている要対応を、通知先にメールで送ってみる（管理者）。通知済みの印は付けない。
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
    if (t.getHandlerFunction() === FEED_TRIGGER_FUNCTION) ScriptApp.deleteTrigger(t);
  });
  return n;
}

/** RSS の確認のトリガー（1時間ごと）を作る。もうあれば何もしない（v0.113.0） */
function ensureFeedTrigger_() {
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === FEED_TRIGGER_FUNCTION; });
  if (!has) ScriptApp.newTrigger(FEED_TRIGGER_FUNCTION).timeBased().everyHours(1).create();
}

/**
 * 1時間ごとのトリガーから呼ばれる（v0.113.0）。設定「配信を確かめる間隔（時間）」がたっていれば、RSS を読む。
 *   前は毎朝の通知の処理（1日1回）でしか読んでいなかったので、間隔を6時間にしても1日1回しか動いていなかった。
 *   画面（google.script.run）からも呼べてしまうので、実在するトリガーの番号が付いていない呼び出しは何もしない。
 */
function runFeedCheck(e) {
  const uid = e && typeof e.triggerUid === 'string' ? e.triggerUid : '';
  if (!uid) return;
  const real = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === FEED_TRIGGER_FUNCTION && String(t.getUniqueId()) === uid;
  });
  if (!real || !isSetupDone_()) return;
  try { refreshFeedCore_(false); } catch (err) { console.error('自動更新（RSS）の確認でエラー: ' + (err && err.stack ? err.stack : err)); }
}

/** メニュー：毎朝の通知を設定する（設定し直すときも同じ） */
function setupDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  if (!isSetupDone_()) { ui.alert('先に初期設定を実行してください。'); return; }
  const settings = getSettings_();
  const hour = settingInt_(settings, '通知の時刻', 8, 23);
  deleteDailyTriggers_();
  ScriptApp.newTrigger(ALERT_TRIGGER_FUNCTION).timeBased().everyDays(1).atHour(hour).create();
  ensureFeedTrigger_();       // RSS は、設定の間隔ごとに読む（v0.113.0）
  // メールを送る許可をここで求めておく（許可が無いと、朝の送信が失敗する）
  MailApp.getRemainingDailyQuota();
  const to = alertRecipients_(settings);
  ui.alert('毎朝 ' + hour + ' 時台に、要対応の確認と通知を行うようにしました。RSS（Windows情報）は、設定の「配信を確かめる間隔」ごとに読みます。\n\n' +
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
//   控えは1時間で切れるので、誰も使わない時間が続いた後でも、ログインがすぐ終わる（シートを読まずに済む）。
//   それ以外の時間は、時刻を見てすぐ終わる（ほとんど時間を使わない）。
// ---------------------------------------------------------------------------
/** 控えを作っておく（誰のログインでもない。画面に渡す部品だけ） */
function warmUpCore_() {
  cachePrime_();
  bootParts_(['customers', 'devices', 'diagnostics', 'licenses', 'allocations', 'repairs', 'activities', 'maintenances', 'memos', 'notices',
    'rentals', 'loans', 'projects', 'saleslogs', 'photoCounts', 'wininfo', 'alertStates'].concat(ALERT_PART_NAMES));
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
    'しばらく誰も使わなかった後でも、ログインが速くなります。時間を変えたい時は、Config.gs の WARM_FROM_HOUR／WARM_TO_HOUR。');
}

/** メニュー：起こしておくのをやめる */
function removeWarmTrigger() {
  const ui = SpreadsheetApp.getUi();
  const n = deleteWarmTriggers_();
  ui.alert(n ? '起こしておくのをやめました。' : '起こしておく設定は入っていません。');
}

// =============================================================================
// ここから：元 Report.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Report.gs … お客様向けの月次レポート
 *
 * 1顧客・1か月ぶんの「やったこと」と「今の状態」をまとめる。画面で見て、ブラウザの印刷でPDFにする。
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
    activities: activities.map(function (a) { return forCustomer_(pick_(a, ['受付日', '対応種別', 'インシデント種別', '内容', 'ステータス'])); }),      // 原文（韓国語）は載せない（v0.140.0）
    repairs: repairs.map(function (r) { return forCustomer_(pick_(r, ['受付日', '完了日', '種別', '件名', 'ステータス'])); }),
    maintenances: maintenances.map(function (m) { return forCustomer_(pick_(m, ['実施日', '種別', '内容'])); }),
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
//   設定「レポートは公開した月だけ見せる」が「はい」の時、お客様ページに出るのは、ここで公開した月だけ。
//   公開した月と、その時の「ひとこと」は、スクリプトのプロパティに顧客ごとに持つ（シートの列は増やさない）
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

// =============================================================================
// ここから：元 Calendar.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Calendar.gs … ミーティングの「今週のスケジュール」（Google カレンダーを読むだけ。v0.61.0）
 *
 *   1. 設定の「カレンダーID」に、共有されているカレンダーのIDを入れる
 *      （Google カレンダー →「設定と共有」→「カレンダーの統合」の「カレンダーID」）。
 *   2. 「納品の予定に使う言葉」に当てはまる予定は、納品として色を付けて、台数を数える。
 *   3. 台数は、予定名（なければ説明）の「10台」「×10」「x10」から読む。最初に見つかった数を使う。
 *
 *   カレンダーは読み取りだけ。予定を足したり直したりはしない。
 *   このスクリプトを動かしているアカウントが、そのカレンダーを見られること（共有されていること）が要る。
 *   初めて使う時は、Google の「承認」（カレンダーを見る権限）が1回要る。
 */

const CAL_MAX_DAYS = 45;          // 一度に取れる期間（日）
const CAL_MAX_EVENTS = 150;       // 一度に返す予定の数
const CAL_CACHE_SECONDS = 300;    // 同じ期間を続けて開いた時の控え（5分）
const CAL_DEFAULT_WORDS = '納品,搬入,設置,キッティング';

/** 全角の数字を半角にする */
function calHalf_(s) {
  return String(s || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
}

/** 予定名・説明から台数を読む（「10台」「×10」「x10」。最初に見つかった数）。無ければ 0 */
function calUnits_(title, desc) {
  const re = /(\d{1,4})\s*台|[×xX＊*]\s*(\d{1,4})(?!\d)/;
  const find = function (text) {
    const m = re.exec(calHalf_(text));
    return m ? Number(m[1] || m[2]) : 0;
  };
  return find(title) || find(desc);
}

/** 「納品の予定に使う言葉」を配列にする（カンマ・読点・改行区切り） */
function calWords_(settings) {
  const raw = String(settings['納品の予定に使う言葉'] === undefined ? CAL_DEFAULT_WORDS : settings['納品の予定に使う言葉']);
  return raw.split(/[,、，\n]/).map(function (w) { return w.trim(); }).filter(function (w) { return w; }).slice(0, 20);
}

/** 設定のカレンダーID（カンマ区切り）を並びにする（v0.114.0） */
function calIds_(raw) {
  return String(raw || '').split(/[,、\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x; }).slice(0, 10);
}

/** カレンダーを開く。見つからない・権限が無い時は、画面に出すエラーにする */
function openCalendar_(id) {
  let cal;
  try { cal = CalendarApp.getCalendarById(id); } catch (e) {
    console.error('カレンダーを開けませんでした: ' + (e && e.stack ? e.stack : e));
    throw appError_('calendar', 'カレンダーを開けませんでした。初めて使う時は、スクリプトの「承認」（カレンダーの権限）が要ります。');
  }
  return cal || null;
}
const CAL_NOT_FOUND = 'カレンダーが見つかりません。IDが合っているか、このスクリプトを動かしているアカウントのカレンダー一覧に、そのカレンダーが入っているか（共有されただけでは足りません。「他のカレンダー」に追加が要ります）を確かめてください。メニューの「カレンダーを使えるようにする」で、見えるカレンダーのIDの一覧が出ます。';

/**
 * Google カレンダーの予定を、画面に出す形にする（読み取りだけ）。
 * v0.114.0：カレンダーIDをカンマで区切って、いくつでも（10個まで）。予定ごとに、どのカレンダーかを cal に入れる。
 */
function calendarEvents_(settings, from, to) {
  const ids = calIds_(settings['カレンダーID']);
  if (!ids.length) return null;
  const words = calWords_(settings);
  const cacheKey = 'cal:' + ids.join(',').slice(0, 160) + ':' + from + ':' + to + ':' + words.join('|').slice(0, 60);
  try {
    const hit = CacheService.getScriptCache().get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* 控えが使えなくても続ける */ }
  const start = calDate_(from), end = calDate_(addDays_(to, 1));
  const tz = scriptTz_();
  let all = [], total = 0;
  const names = [], missing = [];
  ids.forEach(function (id) {
    const cal = openCalendar_(id);
    if (!cal) { missing.push(id); return; }
    let calName = '';
    try { calName = String(cal.getName() || '').slice(0, 60); } catch (e) { /* 名前が取れなくても続ける */ }
    names.push(calName || id);
    let list;
    try { list = cal.getEvents(start, end); } catch (e) {
      console.error('予定を読めませんでした: ' + (e && e.stack ? e.stack : e));
      throw appError_('calendar', '予定を読めませんでした。少し待ってからもう一度試してください。');
    }
    total += list.length;
    all = all.concat(list.slice(0, CAL_MAX_EVENTS).map(function (ev) {
      const title = String(ev.getTitle() || ''), desc = String(ev.getDescription() || '');
      const allDay = !!ev.isAllDayEvent();
      const s = ev.getStartTime(), e = ev.getEndTime();
      // 終日の予定の終わりは、次の日の0時（その日は含まない）
      const endShown = allDay ? new Date(e.getTime() - 1000) : e;
      // v0.115.0：納品かどうかは予定名（タイトル）だけで見る（説明に言葉が入っているだけの予定を、納品にしない）
      const hay = title;
      return {
        title: title.slice(0, 120),
        desc: desc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        place: String(ev.getLocation() || '').slice(0, 100),
        allDay: allDay,
        date: Utilities.formatDate(s, tz, 'yyyy-MM-dd'),
        endDate: Utilities.formatDate(endShown, tz, 'yyyy-MM-dd'),
        start: allDay ? '' : Utilities.formatDate(s, tz, 'HH:mm'),
        end: allDay ? '' : Utilities.formatDate(e, tz, 'HH:mm'),
        units: calUnits_(title, desc),
        delivery: words.some(function (w) { return hay.indexOf(w) !== -1; }),
        cal: ids.length > 1 ? (calName || id) : ''
      };
    }));
  });
  if (!names.length) throw appError_('calendar', CAL_NOT_FOUND);
  const key = function (x) { return x.date + (x.start || '00:00'); };
  all.sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; });
  const out = { events: all.slice(0, CAL_MAX_EVENTS), truncated: total > CAL_MAX_EVENTS || all.length > CAL_MAX_EVENTS, name: names.join('・'), missing: missing };
  try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(out), CAL_CACHE_SECONDS); } catch (e) { /* 控えに入らなくても続ける */ }
  return out;
}

/** yyyy-MM-dd の0時（スクリプトのタイムゾーン） */
function calDate_(ymd) {
  const p = ymd.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

/**
 * ミーティング用：期間（from〜to）の Google カレンダーの予定を返す。
 * カレンダーIDが未設定なら { configured:false }。
 * @param {{token:string, from:string, to:string}} params
 */
function getCalendarWeek(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const from = parseYmd_(p.from), to = parseYmd_(p.to);
    if (!from || !to || to < from) throw appError_('invalid', '期間の日付が正しくありません。');
    if ((calDate_(to) - calDate_(from)) / 86400000 > CAL_MAX_DAYS) throw appError_('invalid', '期間が長すぎます（' + CAL_MAX_DAYS + '日まで）。');
    const settings = getSettings_();
    const r = calendarEvents_(settings, from, to);
    if (!r) return { configured: false, from: from, to: to, events: [] };
    // 納品以外の予定は、設定で「出す」にした時だけ。出さないものは、サーバーから画面へも送らない（v0.62.0）
    const all = settings['納品以外の予定も出す'] === YES;
    const events = all ? r.events : r.events.filter(function (e) { return e.delivery; });
    const shown = String(settings['カレンダーの表示名'] || '').trim() || r.name || '';
    return { configured: true, from: from, to: to, events: events, onlyDelivery: !all, truncated: r.truncated, calendarName: shown, missing: r.missing || [] };
  });
}

/**
 * メニュー（またはスクリプトエディタ）から1回だけ実行する：Google に「カレンダーを見る権限」を許可してもらう（v0.61.2）。
 * 中身はカレンダーの一覧を数えるだけ（読むだけ・何も変えない。何も返さない）。初めて実行すると、許可の画面が出る。
 * エディタから実行した時は画面（メニュー）が使えないので、結果は「実行ログ」に出る（v0.61.3）。
 */
/**
 * v0.118.0：定期保守の予定を「書き込めるか」を確かめる。
 *   Google の承認画面は、項目ごとにチェックを外せる（細かい同意）。カレンダーの「予定の作成・変更」を外すと、
 *   読むことはできても、予定を入れるところで止まる。ここで書き込みの権限を求め直し、実際に試しの予定を入れて消す。
 */
const CAL_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar';
function calendarWriteCheck_() {
  try {
    if (typeof ScriptApp.requireScopes === 'function') ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [CAL_WRITE_SCOPE]);
  } catch (e) {
    console.warn('書き込みの権限を求め直せませんでした: ' + e);
  }
  const ids = calIds_(getSettings_()['定期保守のカレンダーID']);
  if (!ids.length) return '定期保守のカレンダーIDがまだ無いので、書き込みは試していません（設定に入れてから、もう一度実行してください）。';
  const out = [];
  ids.forEach(function (id) {
    try {
      const cal = CalendarApp.getCalendarById(id);
      if (!cal) { out.push('✕ ' + id + '：見つかりません'); return; }
      const t = new Date(2000, 0, 1, 9, 0);
      const ev = cal.createEvent('【PC管理パッケージ】書き込みの確認（すぐ消えます）', t, new Date(t.getTime() + 60000));
      try { ev.deleteEvent(); } catch (e) { /* 消せなくても、書き込めることは分かった */ }
      out.push('◯ ' + (cal.getName() || id) + '：予定を入れられます');
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      out.push('✕ ' + id + '：予定を入れられません（' + m.slice(0, 160) + '）');
    }
  });
  // v0.118.1：どこで止まっているか見分ける。動かしているアカウントと、そのアカウント自身のカレンダーにも試す
  let who = '';
  try { who = Session.getEffectiveUser().getEmail(); } catch (e) { /* 取れなくても続ける */ }
  let own = '';
  try {
    if (typeof CalendarApp.getDefaultCalendar === 'function') {
      const t = new Date(2000, 0, 1, 9, 0);
      const ev = CalendarApp.getDefaultCalendar().createEvent('【PC管理パッケージ】書き込みの確認（すぐ消えます）', t, new Date(t.getTime() + 60000));
      try { ev.deleteEvent(); } catch (e) { /* そのまま */ }
      own = '◯ 自分のカレンダーには入れられます → 承認は足りています。定期保守のカレンダーを、このアカウントに「予定の変更」の権限で共有してください';
    }
  } catch (e) {
    own = '✕ 自分のカレンダーにも入れられません → 承認（OAuth）が足りません（' + String(e && e.message ? e.message : e).slice(0, 160) + '）';
  }
  return '定期保守のカレンダーへの書き込み（動かしているアカウント：' + (who || '不明') + '）：\n' + out.join('\n') + (own && out.some(function (x) { return x.indexOf('✕') === 0; }) ? '\n\n' + own : '');
}
function authorizeCalendar() {
  let msg;
  try {
    const cals = CalendarApp.getAllCalendars();
    // このアカウントが見えるカレンダーの名前とID（設定の「カレンダーID」には、ここに出たIDを入れる）。v0.61.4
    const lines = cals.slice(0, 30).map(function (c) { return '・' + c.getName() + '  →  ' + c.getId(); });
    msg = 'カレンダーを読めます（見えるカレンダー ' + cals.length + '件）。設定の「カレンダーID」には、下のIDを入れてください。\n' + lines.join('\n');
    msg += '\n\n' + calendarWriteCheck_();
  } catch (e) {
    console.error('カレンダーの権限を確かめられませんでした: ' + (e && e.stack ? e.stack : e));
    msg = 'カレンダーを読めませんでした。README の「承認が出ない時」を見てください。\n' + String(e && e.message ? e.message : e).slice(0, 200);
  }
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* エディタやウェブからは画面が使えない。ログだけ */ }
}

// =============================================================================
// 定期保守の日程を自動で作る（v0.114.0）
//   1. 対象：保守契約が「定期保守」の有効な顧客のうち、その月にまだ定期保守の記録も予定も無いところ。
//   2. 先月の実施日があれば、今月も同じ「第何○曜日」を第一候補にする。
//   3. 住所の市区町村（無ければ「地域」）が同じ顧客を、同じ日・同じカレンダーにまとめる。
//   4. 平日だけ（土日・祝日は外す）。カレンダー（担当）ごとに、1日の上限・開始〜終了の時刻・移動時間を守る。
//      そのカレンダーに終日の予定（休みなど）がある日は使わない。
//   5. 1社の時間は、PC台数 10台ごとに「10台あたりの時間」（10台以下は1回ぶん）。
//   画面で確かめて直してから、registerMaintenancePlan でカレンダーに入れる（予定名は「【定期保守】顧客名」）。
// =============================================================================
const MAINT_EVENT_PREFIX = '【定期保守】';
const MAINT_EVENT_TITLE = '仮【定期保守】';      // v0.119.0：作った予定は「仮」。確定したら「仮」を消して使う（どちらも定期保守の予定として数える）
const MAINT_PLAN_PROP = 'maintPlanRanAt';         // v0.119.0：日程をカレンダーに入れた月（yyyy-MM）。その月はダッシュボードのボタンを出さない
function isMaintEventTitle_(title) {
  const t = String(title || '').replace(/^\s+/, '');
  return t.indexOf(MAINT_EVENT_PREFIX) === 0 || t.indexOf(MAINT_EVENT_TITLE) === 0;
}
function maintPlanRanMonth_() {
  try { return String(PropertiesService.getScriptProperties().getProperty(MAINT_PLAN_PROP) || ''); } catch (e) { return ''; }
}
const JP_HOLIDAY_CAL = 'ja.japanese#holiday@group.v.calendar.google.com';

/** 住所から、市区町村（政令市は「○○市○○区」まで）を取り出す。取れなければ '' */
function cityOf_(address) {
  const a = String(address || '').replace(/^〒?\s*\d{3}-?\d{4}\s*/, '').replace(/\s+/g, '');
  const m = /^(?:.{2,3}?[都道府県])?(.+?市.+?区|.+?[市区町村]|.+?郡.+?[町村])/.exec(a);
  return m ? m[1] : '';
}

/** 'H:mm' → 0時からの分 */
function hmToMin_(v, fallback) {
  // v0.117.0：シートが「9:00」を時刻（日付つき）に変えてしまったときも読む
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getHours() * 60 + v.getMinutes();
  const s = String(v || '').trim();
  let m = /^(\d{1,2})[:：](\d{2})$/.exec(s);
  if (!m && /GMT|\d{4}/.test(s)) m = /(\d{1,2}):(\d{2}):\d{2}/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}
function minToHm_(n) { return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2); }

/** その月の第何○曜日か（1〜5）と曜日 */
function nthWeekday_(ymd) {
  const d = calDate_(ymd);
  return { n: Math.floor((d.getDate() - 1) / 7) + 1, wd: d.getDay() };
}
/** 月 ym（yyyy-MM）の第 n ○曜日。無ければ（第5など）その月の最後の○曜日 */
function dateOfNth_(ym, n, wd) {
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7)) - 1;
  const first = new Date(y, mo, 1);
  let day = 1 + ((wd - first.getDay() + 7) % 7) + (n - 1) * 7;
  const last = new Date(y, mo + 1, 0).getDate();
  while (day > last) day -= 7;
  return Utilities.formatDate(new Date(y, mo, day), scriptTz_(), 'yyyy-MM-dd');
}

/** 日本の祝日（Google の「日本の祝日」カレンダー）。読めなければ [] と、読めなかった印 */
function jpHolidays_(from, to) {
  try {
    let cal = CalendarApp.getCalendarById(JP_HOLIDAY_CAL);
    if (!cal && typeof CalendarApp.subscribeToCalendar === 'function') {
      try { cal = CalendarApp.subscribeToCalendar(JP_HOLIDAY_CAL); } catch (e) { cal = null; }
    }
    if (!cal) return { days: [], ok: false };
    const tz = scriptTz_();
    const days = cal.getEvents(calDate_(from), calDate_(addDays_(to, 1))).map(function (ev) { return Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'); });
    return { days: days, ok: true };
  } catch (e) {
    console.warn('祝日を読めませんでした: ' + e);
    return { days: [], ok: false };
  }
}

function maintSettings_(settings) {
  return {
    ids: calIds_(settings['定期保守のカレンダーID']),
    cap: Math.max(1, settingInt_(settings, '定期保守の1日の上限（社）', 3, 20)),
    per10: Math.max(10, settingInt_(settings, '定期保守の10台あたりの時間（分）', 30, 480)),
    startMin: hmToMin_(settings['定期保守の開始時刻'], 9 * 60),
    endMin: hmToMin_(settings['定期保守の終了時刻'], 17 * 60),
    travel: settingInt_(settings, '定期保守の移動時間（分）', 30, 240)
  };
}

/** 予定の説明から顧客IDを読む（このアプリが入れた予定） */
function maintEventCustomer_(desc) {
  const m = /顧客ID[:：]\s*([A-Za-z0-9_-]+)/.exec(String(desc || ''));
  return m ? m[1] : '';
}

/**
 * 定期保守の日程の案を作る（カレンダーにはまだ入れない）。
 * @param {{token:string, month:string}} params month は yyyy-MM（省略すると今月）
 */
function planMaintenance(params) {
  return api_(function () {
    try { return planMaintenance_(params); } catch (e) { throw maintErr_(e, '日程の案を作れませんでした'); }
  });
}
/** v0.117.0：思わぬエラーの時、原因の文を画面に出す（「サーバーでエラー」だけだと直せないため） */
function maintErr_(e, what) {
  if (e && e.appCode) return e;
  console.error(what + ': ' + (e && e.stack ? e.stack : e));
  const msg = String(e && e.message ? e.message : e).slice(0, 200);
  if (/permission|権限|authoriz/i.test(msg)) return appError_('calendar', what + '。予定を入れる権限がありません。Apps Script のエディタで関数「authorizeCalendar」を選んで「実行」し、承認の画面でカレンダーの項目（予定の表示・編集…）全てにチェックを入れて許可してください。その後、ウェブアプリを新しいバージョンでデプロイし直してください。（' + msg.slice(0, 80) + '）');
  return appError_('server', what + '。（原因：' + msg + '）');
}
function planMaintenance_(params) {
  {
    const p = params || {};
    requireSession_(p.token);
    const settings = getSettings_();
    const ms = maintSettings_(settings);
    if (!ms.ids.length) throw appError_('invalid', '設定の「定期保守のカレンダーID」を入れてください。');
    if (ms.endMin <= ms.startMin) throw appError_('invalid', '設定の「定期保守の終了時刻」は、開始時刻より後にしてください。');
    const today = todayYmd_();
    const month = /^\d{4}-\d{2}$/.test(String(p.month || '')) ? String(p.month) : today.slice(0, 7);
    const monthStart = month + '-01';
    const monthEnd = Utilities.formatDate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0), scriptTz_(), 'yyyy-MM-dd');
    if (monthEnd < today) throw appError_('invalid', '過ぎた月の日程は作れません。');
    const firstDay = monthStart > today ? monthStart : addDays_(today, 1);
    const tz = scriptTz_();

    // カレンダー（担当）ごとの、その月の予定
    const cals = [];
    const scheduled = {};              // すでに予定がある顧客
    ms.ids.forEach(function (id) {
      const cal = openCalendar_(id);
      if (!cal) throw appError_('calendar', '定期保守のカレンダー（' + id + '）が見つかりません。' + CAL_NOT_FOUND);
      let name = id;
      try { name = String(cal.getName() || id); } catch (e) { /* 名前なしでも続ける */ }
      const off = {}, used = {};
      cal.getEvents(calDate_(monthStart), calDate_(addDays_(monthEnd, 1))).forEach(function (ev) {
       try {
        const d = Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd');
        const title = String(ev.getTitle() || '');
        if (isMaintEventTitle_(title)) {
          const cid = maintEventCustomer_(ev.getDescription());
          if (cid) scheduled[cid] = d;
          const s = ev.getStartTime(), e = ev.getEndTime();
          (used[d] = used[d] || []).push([s.getHours() * 60 + s.getMinutes(), e.getHours() * 60 + e.getMinutes()]);
        } else if (ev.isAllDayEvent()) {
          off[d] = true;          // 休みなど
        }
       } catch (e) { console.warn('予定を読めませんでした（飛ばします）: ' + e); }   // 「予定あり」しか見えない予定など
      });
      cals.push({ id: id, name: name, off: off, used: used });
    });

    const hol = jpHolidays_(monthStart, monthEnd);
    const holidays = {};
    hol.days.forEach(function (d) { holidays[d] = true; });
    const workdays = [];
    for (let d = firstDay; d <= monthEnd; d = addDays_(d, 1)) {
      const wd = calDate_(d).getDay();
      if (wd !== 0 && wd !== 6 && !holidays[d]) workdays.push(d);
    }

    // 対象の顧客
    const prevMonth = Utilities.formatDate(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1), tz, 'yyyy-MM');
    const maints = readTable_(SHEET_MAINT).rows.filter(function (m) { return m['種別'] === MAINT_KIND_REGULAR; });
    const doneThis = {}, lastPrev = {};
    maints.forEach(function (m) {
      const d = String(m['実施日'] || ''), c = String(m['顧客ID']);
      if (d.slice(0, 7) === month) doneThis[c] = true;
      if (d.slice(0, 7) === prevMonth && (!lastPrev[c] || d > lastPrev[c])) lastPrev[c] = d;
    });
    const devCount = {};
    readTable_(SHEET_DEVICES).rows.forEach(function (d) { if (d['状況'] !== '廃棄') devCount[d['顧客ID']] = (devCount[d['顧客ID']] || 0) + 1; });
    const skipped = [];
    const targets = readTable_(SHEET_CUSTOMERS).rows.filter(function (c) {
      return c['保守契約'] === MAINT_KIND_REGULAR && c['状態'] === '有効' && c['顧客名'] !== PENDING_CUSTOMER_NAME;
    }).filter(function (c) {
      const id = String(c['顧客ID']);
      if (doneThis[id]) { skipped.push({ customerId: id, name: c['顧客名'], reason: 'この月はもう実施した' }); return false; }
      if (scheduled[id]) { skipped.push({ customerId: id, name: c['顧客名'], reason: 'もう予定がある（' + scheduled[id] + '）' }); return false; }
      return true;
    }).map(function (c) {
      const id = String(c['顧客ID']), n = devCount[id] || 0;
      const prev = lastPrev[id] || '';
      let pref = '';
      if (prev) { const nw = nthWeekday_(prev); pref = dateOfNth_(month, nw.n, nw.wd); }
      return {
        customerId: id, name: c['顧客名'], address: String(c['住所'] || ''),
        area: cityOf_(c['住所']) || String(c['地域'] || '') || '（住所なし）',
        devices: n, minutes: Math.max(1, Math.ceil(n / 10)) * ms.per10, prev: prev, pref: pref
      };
    });

    // 地域ごとにまとめる。先月の候補日が早い地域から
    const groups = {};
    targets.forEach(function (t) { (groups[t.area] = groups[t.area] || []).push(t); });
    const firstPref = function (list) { return list.map(function (t) { return t.pref || '9999'; }).sort()[0]; };
    const areaList = Object.keys(groups).sort(function (a, b) { const x = firstPref(groups[a]), y = firstPref(groups[b]); return x < y ? -1 : x > y ? 1 : a < b ? -1 : 1; });

    // 日・カレンダーごとの空き
    const slot = {};      // key d|calIndex → { count, next }
    const slotOf = function (d, ci) {
      const k = d + '|' + ci;
      if (!slot[k]) {
        const used = cals[ci].used[d] || [];
        const lastEnd = used.reduce(function (mx, u) { return Math.max(mx, u[1]); }, 0);
        slot[k] = { count: used.length, next: used.length ? Math.max(ms.startMin, lastEnd + ms.travel) : ms.startMin };
      }
      return slot[k];
    };
    const fits = function (d, ci, t) {
      if (cals[ci].off[d]) return false;
      const s = slotOf(d, ci);
      return s.count < ms.cap && s.next + t.minutes <= ms.endMin;
    };
    const plan = [];
    const place = function (d, ci, t) {
      const s = slotOf(d, ci);
      plan.push({ customerId: t.customerId, name: t.name, area: t.area, address: t.address, devices: t.devices, minutes: t.minutes,
        date: d, start: minToHm_(s.next), end: minToHm_(s.next + t.minutes), calendarId: cals[ci].id, prev: t.prev });
      s.count++;
      s.next = s.next + t.minutes + ms.travel;
    };
    areaList.forEach(function (area) {
      const list = groups[area].slice().sort(function (a, b) { return (a.pref || '9999') < (b.pref || '9999') ? -1 : 1; });
      let i = 0;
      while (i < list.length) {
        const want = list[i].pref || '';
        // 先月と同じ曜日の日から（無ければ月のはじめから）探して、空きのある日・カレンダーに入れる
        let startIdx = workdays.findIndex(function (d) { return d >= want; });
        if (startIdx === -1) startIdx = 0;
        let placed = false;
        for (let k = 0; k < workdays.length && !placed; k++) {
          const d = workdays[(startIdx + k) % workdays.length];
          for (let ci = 0; ci < cals.length && !placed; ci++) {
            if (!fits(d, ci, list[i])) continue;
            // 同じ地域の残りも、入るだけ同じ日・同じカレンダーに
            while (i < list.length && fits(d, ci, list[i])) { place(d, ci, list[i]); i++; }
            placed = true;
          }
        }
        if (!placed) { skipped.push({ customerId: list[i].customerId, name: list[i].name, reason: 'この月に空きがない' }); i++; }
      }
    });
    plan.sort(function (a, b) { return (a.date + a.calendarId + ('0' + a.start).slice(-5)) < (b.date + b.calendarId + ('0' + b.start).slice(-5)) ? -1 : 1; });
    return {
      month: month, plan: plan, skipped: skipped, holidaysOk: hol.ok, holidays: hol.days,
      calendars: cals.map(function (c) { return { id: c.id, name: c.name }; }),
      rules: { cap: ms.cap, per10: ms.per10, start: minToHm_(ms.startMin), end: minToHm_(ms.endMin), travel: ms.travel }
    };
  }
}

/**
 * 日程の案を、カレンダーに入れる。
 * @param {{token:string, items:Array<{customerId:string, date:string, start:string, end:string, calendarId:string}>}} params
 */
function registerMaintenancePlan(params) {
  return api_(function () {
    try { return registerMaintenancePlan_(params); } catch (e) { throw maintErr_(e, 'カレンダーに入れられませんでした'); }
  });
}
function registerMaintenancePlan_(params) {
  {
    const p = params || {};
    const me = requireSession_(p.token);
    const settings = getSettings_();
    const ids = calIds_(settings['定期保守のカレンダーID']);
    const items = Array.isArray(p.items) ? p.items.slice(0, 200) : [];
    if (!items.length) throw appError_('invalid', '入れる日程がありません。');
    const custs = {};
    readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { custs[String(c['顧客ID'])] = c; });
    const devCount = {};
    readTable_(SHEET_DEVICES).rows.forEach(function (d) { if (d['状況'] !== '廃棄') devCount[d['顧客ID']] = (devCount[d['顧客ID']] || 0) + 1; });
    const calCache = {};
    const out = { created: 0, skipped: [] };
    const doneByMonth = {};
    const monthDone = function (ym) {
      if (doneByMonth[ym]) return doneByMonth[ym];
      const set = {};
      const mStart = calDate_(ym + '-01');
      const mEnd = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 1);
      ids.forEach(function (id) {
        const cl = calCache[id] !== undefined ? calCache[id] : (calCache[id] = openCalendar_(id));
        if (!cl) return;
        cl.getEvents(mStart, mEnd).forEach(function (ev) {
          try {
            if (isMaintEventTitle_(ev.getTitle())) { const cid = maintEventCustomer_(ev.getDescription()); if (cid) set[cid] = true; }
          } catch (err) { /* 読めない予定は飛ばす */ }
        });
      });
      return (doneByMonth[ym] = set);
    };
    items.forEach(function (it) {
      const c = custs[String(it.customerId)];
      const date = parseYmd_(it.date);
      const s = hmToMin_(it.start, -1), e = hmToMin_(it.end, -1);
      if (!c || !date || s < 0 || e <= s) { out.skipped.push({ customerId: it.customerId, reason: '日付・時刻が正しくない' }); return; }
      if (ids.indexOf(String(it.calendarId)) === -1) { out.skipped.push({ customerId: it.customerId, reason: '設定に無いカレンダー' }); return; }
      const cal = calCache[it.calendarId] !== undefined ? calCache[it.calendarId] : (calCache[it.calendarId] = openCalendar_(it.calendarId));
      if (!cal) { out.skipped.push({ customerId: it.customerId, reason: 'カレンダーが見つからない' }); return; }
      // 同じ月に、同じ顧客の定期保守の予定がもうあれば入れない（2回押した時）。
      // v0.123.0：月ごとに、設定のカレンダー全部を1回だけ読む（前は1件ごとに読んでいて、件数が多いと遅かった。
      //   別のカレンダー（担当）に入っている予定も2重とみなす）
      const done = monthDone(date.slice(0, 7));
      if (done[String(c['顧客ID'])]) { out.skipped.push({ customerId: it.customerId, reason: 'もう予定がある' }); return; }
      const d0 = calDate_(date);
      const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), Math.floor(s / 60), s % 60);
      const end = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), Math.floor(e / 60), e % 60);
      const made = cal.createEvent(MAINT_EVENT_TITLE + c['顧客名'], start, end, {
        location: String(c['住所'] || ''),
        description: '顧客ID：' + c['顧客ID'] + '\nPC ' + (devCount[c['顧客ID']] || 0) + '台\n' + (c['電話'] ? '電話：' + c['電話'] + '\n' : '') + '（PC管理パッケージで作成）'
      });
      // v0.120.0：色はトマト（CalendarApp の RED ＝ カレンダーの「トマト」）
      try { made.setColor(CalendarApp.EventColor.RED); } catch (err) { /* 色を付けられなくても予定は入っている */ }
      done[String(c['顧客ID'])] = true;      // 同じ登録の中で、同じ顧客を2回入れない
      out.created++;
    });
    if (out.created) { try { PropertiesService.getScriptProperties().setProperty(MAINT_PLAN_PROP, todayYmd_().slice(0, 7)); } catch (e) { /* 控えなくても続ける */ } }
    out.ranMonth = maintPlanRanMonth_();
    if (out.created) logAudit_('定期保守の日程を登録', '', '', '', '', out.created + '件をカレンダーに入れた', me.name);
    return out;
  }
}
