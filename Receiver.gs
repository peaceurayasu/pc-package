/**
 * Receiver.gs … PC情報収集ツール（PCInfoTool）からの受信
 *
 * ツールの設定
 *   送信先URL   … このウェブアプリのURL（.../exec）
 *   APIトークン … 顧客ごとに発行した「受信トークン」
 *
 * 動き
 *   - 受信トークンで顧客を決める。トークンが無い・違う送信は受け付けない
 *   - 同じ顧客の中で、シリアルが同じ機器を探す。無ければ機器を自動で登録する
 *   - 台帳（機器シート）の手入力した内容は上書きしない。空いている メーカー・機種名・シリアル だけ埋める
 *   - ツールの値は「機器診断」シートに、1機器1行で最新の値を持つ
 *
 * 公開関数：doPost / issueReceiveToken / getReceiveInfo / getDeviceDiagnostics
 */

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 収集ツールからの送信を受ける */
function doPost(e) {
  let result;
  try {
    result = receiveCore_(e);
    result.ok = true;
  } catch (err) {
    if (err && err.appCode) {
      result = { ok: false, error: err.appCode, message: err.message };
    } else {
      console.error('受信で予期しないエラー: ' + (err && err.stack ? err.stack : err));
      result = { ok: false, error: 'server', message: 'サーバーでエラーが起きました。' };
    }
  }
  return jsonOutput_(result);
}

function isJunkSerial_(serial) {
  return !serial || serial.length < 5 || JUNK_SERIAL.test(serial);
}

/** ツールが取ってきたメーカー名を、選択肢の値に当てはめる。当てはまらなければ '' */
function normalizeMaker_(raw, options) {
  const s = String(raw || '').toLowerCase();
  if (!s) return '';
  const active = (options['メーカー'] || []).filter(function (o) { return o.active; }).map(function (o) { return o.value; });
  for (let i = 0; i < active.length; i++) {
    if (active[i].toLowerCase() === s) return active[i];
  }
  for (let i = 0; i < MAKER_ALIASES.length; i++) {
    const key = MAKER_ALIASES[i][0];
    // 'hp' や 'nec' のような短い語は、語の区切りで一致したときだけ当てはめる
    const hit = key.length <= 3 ? new RegExp('(^|[^a-z])' + key + '([^a-z]|$)').test(s) : s.indexOf(key) !== -1;
    if (hit && active.indexOf(MAKER_ALIASES[i][1]) !== -1) return MAKER_ALIASES[i][1];
  }
  return '';
}

/** バッテリーの情報から、ノートかデスクトップかを推測する。分からなければ '' */
function guessDeviceKind_(batteryText, options) {
  const s = String(batteryText || '');
  if (!s) return '';
  const guess = s.indexOf('バッテリーなし') !== -1 ? 'デスクトップ' : 'ノート';
  const ok = (options['機器種類'] || []).some(function (o) { return o.active && o.value === guess; });
  return ok ? guess : '';
}

function receiveCore_(e) {
  if (!isSetupDone_()) throw appError_('setup', '初期設定が終わっていません。');
  const body = e && e.postData && e.postData.contents;
  if (typeof body !== 'string' || !body) throw appError_('invalid', '送信の中身がありません。');
  if (body.length > REPORT_MAX_CHARS) throw appError_('invalid', '送信が大きすぎます。');
  let payload;
  try { payload = JSON.parse(body); } catch (err) { throw appError_('invalid', '送信の形式が正しくありません。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw appError_('invalid', '送信の形式が正しくありません。');
  const isReport = payload.kind === 'report';
  // レポート（v0.25.0）だけは大きくてよい。ふつうの送信は、これまでどおりの上限
  if (!isReport && body.length > RECEIVE_MAX_CHARS) throw appError_('invalid', '送信が大きすぎます。');

  const denied = function () { return appError_('unauthorized', 'APIトークンが正しくありません。'); };
  const token = payload.token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw denied();
  const customer = readTable_(SHEET_CUSTOMERS).rows.filter(function (r) { return r['受信トークン'] === token; })[0];
  if (!customer || customer['状態'] !== '有効') throw denied();
  const customerId = String(customer['顧客ID']);

  // 同じ顧客からの送りすぎを止める（トークンが漏れたときに、機器を大量に作られないように）
  const cache = CacheService.getScriptCache();
  const rateKey = 'rcv_' + customerId;
  const count = Number(cache.get(rateKey)) || 0;
  if (count >= RECEIVE_MAX_PER_10MIN) throw appError_('busy', '送信が多すぎます。しばらく待ってください。');
  cache.put(rateKey, String(count + 1), 600);

  if (isReport) return receiveReport_(customerId, payload);

  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
  const text = function (v, max) {
    if (v === null || v === undefined || typeof v === 'object') return '';
    return cleanText_(v, max);
  };

  // 機器診断シートに入れる値
  const diag = {};
  DIAG_MAP.forEach(function (m) {
    const raw = data[m[0]];
    if (m[2] === 'number') {
      const n = parseInt(raw, 10);
      diag[m[1]] = isFinite(n) && n >= 0 && n < 1e9 ? n : '';
    } else if (m[2] === 'text') {
      diag[m[1]] = text(raw, m[3]).replace(/\n/g, ' ');
    } else {
      diag[m[1]] = text(raw, m[3]);
    }
  });
  const serial = (text(payload.serial, 100) || diag['シリアル']).replace(/\n/g, ' ');
  diag['シリアル'] = serial;
  const computerName = diag['コンピューター名'];
  const junk = isJunkSerial_(serial);
  if (junk && !computerName) throw appError_('invalid', 'シリアルもコンピューター名も取れていないので、機器を見分けられません。');

  return withLock_(function () {
    const options = getOptions_();
    const mine = readTable_(SHEET_DEVICES).rows.filter(function (d) { return String(d['顧客ID']) === customerId; });
    const preferLive = function (list) {
      return list.filter(function (d) { return d['状況'] !== '廃棄'; })[0] || list[0] || null;
    };
    let device = null;
    if (!junk) {
      const key = serial.toLowerCase();
      device = preferLive(mine.filter(function (d) { return String(d['シリアル']).trim().toLowerCase() === key; }));
    } else {
      // シリアルが使えないときは、前に同じコンピューター名で受けた機器を探す
      const name = computerName.toLowerCase();
      const ids = {};
      readTable_(SHEET_DIAGNOSTICS).rows.forEach(function (r) {
        if (String(r['コンピューター名']).toLowerCase() === name) ids[String(r['機器ID'])] = true;
      });
      device = preferLive(mine.filter(function (d) { return ids[String(d['機器ID'])]; }));
    }

    const now = nowStamp_();
    const maker = normalizeMaker_(diag['メーカー（取得値）'], options);
    const model = /^(取得失敗|不明)$/.test(diag['機種名（取得値）']) ? '' : diag['機種名（取得値）'];
    let created = false;
    let deviceId;
    if (!device) {
      deviceId = nextId_(SHEET_DEVICES, '機器ID', ENTITIES.device.prefix, ENTITIES.device.digits);
      appendRecord_(SHEET_DEVICES, {
        '機器ID': deviceId, '顧客ID': customerId, '状況': '使用中',
        '種類': guessDeviceKind_(diag['バッテリー状態'], options),
        'メーカー': maker, '機種名': model, 'シリアル': junk ? '' : serial,
        '備考': '収集ツールから自動で登録', '登録日時': now, '更新日時': now
      });
      logAudit_('機器自動登録', deviceId, customerId, '', '', [computerName, model, junk ? '' : serial].filter(function (x) { return x; }).join(' / '), '収集ツール');
      created = true;
    } else {
      deviceId = String(device['機器ID']);
      const fill = {};
      if (!device['メーカー'] && maker) fill['メーカー'] = maker;
      if (!device['機種名'] && model) fill['機種名'] = model;
      if (!device['シリアル'] && !junk) fill['シリアル'] = serial;
      if (Object.keys(fill).length) {
        fill['更新日時'] = now;
        updateRecord_(SHEET_DEVICES, device._row, fill);
      }
    }

    diag['機器ID'] = deviceId;
    diag['受信日時'] = now;
    const existing = findById_(SHEET_DIAGNOSTICS, '機器ID', deviceId);
    if (existing) updateRecord_(SHEET_DIAGNOSTICS, existing._row, diag);
    else appendRecord_(SHEET_DIAGNOSTICS, diag);
    return { deviceId: deviceId, created: created };
  });
}

// ---------------------------------------------------------------------------
// 収集ツールのレポート（v0.25.0）
//   ツール v1.7.0〜 は、ふつうの送信のあとに、作ったレポート（HTML）を kind:'report' で送ってくる。
//   その顧客の機器のうち、シリアル（取れないときはコンピューター名）が合う機器に貼り付ける。
//   ファイルは共有しない（画面からは getDiagReport で中身を読んで、枠の中に出す）。1台に3つまで残す。
// ---------------------------------------------------------------------------
function receiveReport_(customerId, payload) {
  const serial = cleanText_(payload.serial, 100).replace(/\n/g, ' ');
  const computerName = cleanText_(payload.computerName, 60).replace(/\n/g, ' ');
  if (typeof payload.base64 !== 'string' || !payload.base64) throw appError_('invalid', 'レポートの中身がありません。');
  const bytes = decodeUpload_(payload.base64, REPORT_MAX_BYTES);
  const head = bytesToAscii_(bytes.slice(0, 600)).toLowerCase();
  if (head.indexOf('<html') === -1 && head.indexOf('<!doctype html') === -1) throw appError_('invalid', 'レポートの形式が正しくありません。');

  return withLock_(function () {
    const devices = readTable_(SHEET_DEVICES).rows.filter(function (d) { return String(d['顧客ID']) === customerId; });
    const devIds = {};
    devices.forEach(function (d) { devIds[String(d['機器ID'])] = d; });
    const diags = readTable_(SHEET_DIAGNOSTICS, DIAG_LEAN_SKIP).rows.filter(function (g) { return devIds[String(g['機器ID'])]; });
    let diag = null;
    if (!isJunkSerial_(serial)) {
      const key = serial.toLowerCase();
      diag = diags.filter(function (g) { return String(g['シリアル']).trim().toLowerCase() === key; })[0] || null;
    }
    if (!diag && computerName) {
      const name = computerName.toLowerCase();
      diag = diags.filter(function (g) { return String(g['コンピューター名']).toLowerCase() === name; })[0] || null;
    }
    if (!diag) throw appError_('notfound', 'このPCの情報がまだ届いていないので、レポートを貼り付けられません。');
    const deviceId = String(diag['機器ID']);
    const now = nowStamp_();
    const stamp = now.replace(/[^0-9]/g, '').slice(0, 12);
    const name = 'レポート_' + (computerName || deviceId).replace(/[\n\\\/:*?"<>|]/g, '_').slice(0, 40) + '_' + stamp + '.html';
    const file = filesFolder_().createFile(Utilities.newBlob(bytes, 'text/html', customerId + '_' + name));
    const id = nextId_(SHEET_ATTACH, '添付ID', 'F', 5);
    appendRecord_(SHEET_ATTACH, {
      '添付ID': id, '顧客ID': customerId, 'ファイル名': name, 'DriveファイルID': file.getId(), 'サイズ': bytes.length, '種類': 'text/html',
      'お客様に見せる': NO, '登録者': '収集ツール', '登録日時': now, '対象区分': REPORT_TARGET_LABEL, '対象ID': deviceId, '登録者ID': ''
    });
    updateRecord_(SHEET_DIAGNOSTICS, diag._row, { 'レポート添付ID': id, 'レポート受信日時': now });
    // 古いレポートを消す（新しいものから3つ残す）。下の行から消す
    const olds = attachRows_().filter(function (r) { return r['対象区分'] === REPORT_TARGET_LABEL && String(r['対象ID']) === deviceId; })
      .sort(function (a, b) { return String(b['登録日時']) < String(a['登録日時']) ? -1 : String(b['登録日時']) > String(a['登録日時']) ? 1 : b._row - a._row; })
      .slice(REPORT_KEEP_PER_DEVICE)
      .sort(function (a, b) { return b._row - a._row; });
    olds.forEach(function (r) { trashFile_(r['DriveファイルID']); deleteRecord_(SHEET_ATTACH, r._row); });
    logAudit_('収集レポート受信', id, customerId, '', '', name, '収集ツール');
    return { deviceId: deviceId, attachmentId: id };
  });
}

function bytesToAscii_(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) { const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i]; s += b < 128 ? String.fromCharCode(b) : ' '; }
  return s;
}

/**
 * 機器に貼り付けた収集レポートの中身（HTML）。画面では、スクリプトを動かさない枠の中に出す。
 * @param {{token:string, id:string}} params  id は添付ID
 */
function getDiagReport(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const row = attachById_(p.id);
    if (!row || row['対象区分'] !== REPORT_TARGET_LABEL) throw appError_('notfound', 'レポートが見つかりません。');
    let html;
    try { html = DriveApp.getFileById(String(row['DriveファイルID'])).getBlob().getDataAsString('UTF-8'); }
    catch (e) { throw appError_('notfound', 'レポートのファイルが見つかりません（ドライブから消された可能性があります）。'); }
    return { id: String(row['添付ID']), deviceId: String(row['対象ID']), name: String(row['ファイル名']), at: String(row['登録日時']), html: html.replace(/^\uFEFF/, '') };
  });
}

// ---------------------------------------------------------------------------
// PCの健康チェック（v0.26.0）。ミーティングの「先月のまとめ」に出す
//   使用中の機器のうち、収集ツールの最新の値で気をつけたほうがよいものだけを返す。
//   level：danger（すぐ見る）／warn（気にしておく）
// ---------------------------------------------------------------------------
const HEALTH_BATTERY_WARN = 80, HEALTH_BATTERY_DANGER = 50;
const HEALTH_WU_PENDING = 5, HEALTH_WU_STALE_DAYS = 60, HEALTH_COMPARE_MAX = 3;

/** 1台ぶんの気になること。[{level, text}] */
function healthIssues_(g, opt) {
  const out = [];
  const add = function (level, text) { out.push({ level: level, text: text }); };
  const free = parseFloat(g['Cドライブ空き']);
  if (opt.freeMin > 0 && isFinite(free) && free < opt.freeMin) add(free < opt.freeMin / 2 ? 'danger' : 'warn', 'Cドライブの空きが ' + free + 'GB');
  if (/EventID/.test(String(g['ディスク関連イベント'] || ''))) add('danger', 'ディスクに異常の記録');
  const bat = /設計容量比\s*([\d.]+)\s*%/.exec(String(g['バッテリー状態'] || ''));
  if (bat) { const pct = parseFloat(bat[1]); if (pct < HEALTH_BATTERY_WARN) add(pct < HEALTH_BATTERY_DANGER ? 'danger' : 'warn', 'バッテリーの劣化（' + pct + '%）'); }
  const wu = String(g['Windows Update'] || '');
  const pend = /保留中の更新:\s*(\d+)/.exec(wu);
  if (pend && Number(pend[1]) >= HEALTH_WU_PENDING) add('warn', '更新が ' + pend[1] + '件たまっている');
  const last = /（(\d{4})\/(\d{2})\/(\d{2})）/.exec(wu);
  if (last) { const d = dayDiff_(last[1] + '-' + last[2] + '-' + last[3], opt.today); if (d >= HEALTH_WU_STALE_DAYS) add('warn', 'Windows Update が ' + d + '日 当たっていない'); }
  const crash = String(g['クラッシュダンプ'] || '');
  if (crash && !/^(クラッシュダンプなし|取得失敗)/.test(crash)) add('warn', 'ブルースクリーンの記録');
  String(g['前回との比較'] || '').split('\n').filter(function (l) { return /^・/.test(l) && !/スタートアップ/.test(l); })
    .slice(0, HEALTH_COMPARE_MAX).forEach(function (l) { add('warn', '前回より：' + l.replace(/^・\s*/, '')); });
  const got = String(g['受信日時'] || '').slice(0, 10);
  if (opt.staleDays > 0 && got && dayDiff_(got, opt.today) >= opt.staleDays) add('warn', '収集ツールの情報が ' + dayDiff_(got, opt.today) + '日 届いていない');
  return out;
}

/**
 * 気をつけたほうがよいPCの一覧。
 * @param {{token:string}} params
 * @return {{items:Array<{deviceId:string, customerId:string, at:string, reportId:string, issues:Array}>, checked:number, freeMin:number, staleDays:number}}
 */
function getHealthCheck(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const settings = getSettings_();
    const opt = {
      today: todayYmd_(),
      freeMin: settingInt_(settings, 'Cドライブ空きの下限GB', 20, 100000),
      staleDays: settingInt_(settings, '収集ツール未受信の日数', 30, 3650)
    };
    const live = {};
    readTable_(SHEET_CUSTOMERS).rows.forEach(function (c) { if (c['状態'] === '有効') live[String(c['顧客ID'])] = true; });
    const devs = {};
    readTable_(SHEET_DEVICES).rows.forEach(function (d) { if (d['状況'] === '使用中' && live[String(d['顧客ID'])]) devs[String(d['機器ID'])] = d; });
    const items = [];
    let checked = 0;
    readTable_(SHEET_DIAGNOSTICS, ['イベント重大（内容）', 'イベントエラー（内容）', 'プリンター情報', 'スタートアップ']).rows.forEach(function (g) {
      const d = devs[String(g['機器ID'])];
      if (!d) return;
      checked++;
      const issues = healthIssues_(g, opt);
      if (issues.length) items.push({ deviceId: String(d['機器ID']), customerId: String(d['顧客ID']), at: String(g['受信日時'] || ''), reportId: String(g['レポート添付ID'] || ''), issues: issues });
    });
    const rank = function (x) { return x.issues.filter(function (i) { return i.level === 'danger'; }).length * 100 + x.issues.length; };
    items.sort(function (a, b) { return rank(b) - rank(a) || (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0); });
    return { items: items, checked: checked, freeMin: opt.freeMin, staleDays: opt.staleDays };
  });
}

// ---------------------------------------------------------------------------
// 受信トークン（管理者）
// ---------------------------------------------------------------------------
/**
 * 顧客の受信トークンを発行する。発行し直すと、前のトークンを入れたツールからは届かなくなる。
 * @param {{token:string, customerId:string}} params
 */
function issueReceiveToken(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!c) throw appError_('notfound', '顧客が見つかりません。');
      if (tableHead_(SHEET_CUSTOMERS).headers.indexOf('受信トークン') === -1) throw appError_('setup', '顧客のシートに「受信トークン」の列がありません。スプレッドシートのメニューから「初期設定」をもう一度実行してください。');
      const receiveToken = newToken_();
      const had = !!c['受信トークン'];
      updateRecord_(SHEET_CUSTOMERS, c._row, { '受信トークン': receiveToken, '更新日時': nowStamp_() });
      logAudit_(had ? '受信トークン再発行' : '受信トークン発行', c['顧客ID'], c['顧客ID'], '', '', '', me.name);
      const url = webAppUrl_();
      return {
        receiveToken: receiveToken, url: url, needsUrlSetting: !url,
        record: toClient_('customer', findById_(SHEET_CUSTOMERS, '顧客ID', c['顧客ID']))
      };
    });
  });
}

/**
 * 発行済みの受信トークンと、ツールに入れる送信先URLを返す。
 * @param {{token:string, customerId:string}} params
 */
function getReceiveInfo(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
    if (!c) throw appError_('notfound', '顧客が見つかりません。');
    const url = webAppUrl_();
    return { receiveToken: c['受信トークン'] || '', issued: !!c['受信トークン'], url: url, needsUrlSetting: !url };
  });
}

/**
 * 機器1台の、収集ツールから届いた最新の値。まだ届いていなければ diagnostics は null。
 * @param {{token:string, deviceId:string}} params
 */
function getDeviceDiagnostics(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const row = findById_(SHEET_DIAGNOSTICS, '機器ID', p.deviceId);
    return { diagnostics: row ? publicRecord_(row) : null };
  });
}
