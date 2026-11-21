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
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Receiver.gs'] = '0.111.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

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

/** 「仮受付（未割り当て）」の顧客のID。無ければ作る（withLock_ の中で呼ぶ） */
function pendingCustomerId_() {
  return withLock_(function () {
    const found = readTable_(SHEET_CUSTOMERS).rows.filter(function (c) { return c['顧客名'] === PENDING_CUSTOMER_NAME; })[0];
    if (found) return String(found['顧客ID']);
    const now = nowStamp_();
    const id = nextId_(SHEET_CUSTOMERS, '顧客ID', ENTITIES.customer.prefix, ENTITIES.customer.digits);
    appendRecord_(SHEET_CUSTOMERS, {
      '顧客ID': id, '顧客名': PENDING_CUSTOMER_NAME, '状態': '有効', '保守契約': 'なし',
      '備考': 'トークンなしで届いたPCの置き場。機器を開いて、顧客を選び直して振り分ける。', '登録日時': now, '更新日時': now
    });
    logAudit_('顧客自動登録', id, id, '', '', PENDING_CUSTOMER_NAME, '収集ツール（トークンなし）');
    return id;
  });
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
  const cache = CacheService.getScriptCache();
  const tokenless = token === undefined || token === null || token === '';
  let customerId;
  if (tokenless) {
    // トークンなしの仮受付（v0.54.0）：管理者が設定「トークンなしの仮受付」を「はい」にしている間だけ。
    //   届いたPCは「仮受付（未割り当て）」の顧客に入れる（管理者が、機器ごとに本当の顧客へ移す）。
    //   間違ったトークンは、仮受付を開いていても断る。制限：全体で10分に60回・6時間に新しい機器30台まで。
    if (getSettings_()['トークンなしの仮受付'] !== YES) throw denied();
    const pcount = Number(cache.get('rcv_pending')) || 0;
    if (pcount >= PENDING_MAX_PER_10MIN) throw appError_('busy', '送信が多すぎます。しばらく待ってください。');
    cache.put('rcv_pending', String(pcount + 1), 600);
    customerId = pendingCustomerId_();
  } else {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw denied();
    const customer = readTable_(SHEET_CUSTOMERS).rows.filter(function (r) { return r['受信トークン'] === token; })[0];
    if (!customer || customer['状態'] !== '有効') throw denied();
    customerId = String(customer['顧客ID']);

    // 同じ顧客からの送りすぎを止める（トークンが漏れたときに、機器を大量に作られないように）
    const rateKey = 'rcv_' + customerId;
    const count = Number(cache.get(rateKey)) || 0;
    if (count >= RECEIVE_MAX_PER_10MIN) throw appError_('busy', '送信が多すぎます。しばらく待ってください。');
    cache.put(rateKey, String(count + 1), 600);
  }

  if (isReport) return receiveReport_(customerId, payload, tokenless);

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
    const allDevices = readTable_(SHEET_DEVICES).rows;
    const mine = allDevices.filter(function (d) { return String(d['顧客ID']) === customerId; });
    const preferLive = function (list) {
      return list.filter(function (d) { return d['状況'] !== '廃棄'; })[0] || list[0] || null;
    };
    let device = null;
    if (!junk) {
      const key = serial.toLowerCase();
      const bySerial = function (list) { return preferLive(list.filter(function (d) { return String(d['シリアル']).trim().toLowerCase() === key; })); };
      // トークンなし（仮受付）のときは、振り分け済みの機器も含めて、シリアルが同じ機器を探す（v0.66.0）。
      //   見つかれば、その機器（元の顧客のまま）の診断を更新する。仮受付に重複して作らない
      device = bySerial(tokenless ? allDevices : mine);
    } else {
      // シリアルが使えないときは、前に同じコンピューター名で受けた機器を探す
      const name = computerName.toLowerCase();
      const ids = {};
      readTable_(SHEET_DIAGNOSTICS).rows.forEach(function (r) {
        if (String(r['コンピューター名']).toLowerCase() === name) ids[String(r['機器ID'])] = true;
      });
      device = preferLive(mine.filter(function (d) { return ids[String(d['機器ID'])]; }));
    }

    if (device) customerId = String(device['顧客ID']);
    const now = nowStamp_();
    const maker = normalizeMaker_(diag['メーカー（取得値）'], options);
    const model = /^(取得失敗|不明)$/.test(diag['機種名（取得値）']) ? '' : diag['機種名（取得値）'];
    let created = false;
    let deviceId;
    if (!device) {
      if (tokenless) {
        const made = Number(cache.get('rcv_pending_new')) || 0;
        if (made >= PENDING_MAX_NEW_PER_6H) throw appError_('busy', '仮受付で新しく作れる機器の数（6時間に' + PENDING_MAX_NEW_PER_6H + '台）に達しました。');
        cache.put('rcv_pending_new', String(made + 1), 21600);
      }
      deviceId = nextId_(SHEET_DEVICES, '機器ID', ENTITIES.device.prefix, ENTITIES.device.digits);
      appendRecord_(SHEET_DEVICES, {
        '機器ID': deviceId, '顧客ID': customerId, '状況': '使用中',
        '種類': guessDeviceKind_(diag['バッテリー状態'], options),
        'メーカー': maker, '機種名': model, 'シリアル': junk ? '' : serial,
        '備考': tokenless ? '収集ツールから自動で登録（トークンなし・仮受付。本当の顧客を選んでください）' : '収集ツールから自動で登録', '登録日時': now, '更新日時': now
      });
      logAudit_('機器自動登録', deviceId, customerId, '', '', [computerName, model, junk ? '' : serial].filter(function (x) { return x; }).join(' / '), tokenless ? '収集ツール（トークンなし）' : '収集ツール');
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
    // 登録先の顧客名も返す（ツールがログに出す。どこに入ったかを、PC側で確かめられるように。v0.66.1）
    const owner = readTable_(SHEET_CUSTOMERS).rows.filter(function (c) { return String(c['顧客ID']) === customerId; })[0];
    return { deviceId: deviceId, created: created, customerName: owner ? String(owner['顧客名']) : '' };
  });
}

// ---------------------------------------------------------------------------
// 収集ツールのレポート（v0.25.0）
//   ツール v1.7.0〜 は、ふつうの送信のあとに、作ったレポート（HTML）を kind:'report' で送ってくる。
//   その顧客の機器のうち、シリアル（取れないときはコンピューター名）が合う機器に貼り付ける。
//   ファイルは共有しない（画面からは getDiagReport で中身を読んで、枠の中に出す）。1台に3つまで残す。
// ---------------------------------------------------------------------------
function receiveReport_(customerId, payload, tokenless) {
  const serial = cleanText_(payload.serial, 100).replace(/\n/g, ' ');
  const computerName = cleanText_(payload.computerName, 60).replace(/\n/g, ' ');
  if (typeof payload.base64 !== 'string' || !payload.base64) throw appError_('invalid', 'レポートの中身がありません。');
  const bytes = decodeUpload_(payload.base64, REPORT_MAX_BYTES);
  const head = bytesToAscii_(bytes.slice(0, 600)).toLowerCase();
  if (head.indexOf('<html') === -1 && head.indexOf('<!doctype html') === -1) throw appError_('invalid', 'レポートの形式が正しくありません。');

  return withLock_(function () {
    // トークンなしのときは、振り分け済みの機器にも貼り付ける（v0.66.0）
    const devices = readTable_(SHEET_DEVICES).rows.filter(function (d) { return tokenless || String(d['顧客ID']) === customerId; });
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
    customerId = String(devIds[deviceId]['顧客ID']);
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

// =============================================================================
// ここから：元 Release.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Release.gs … 収集ツール（PCInfoTool）の自動更新の配布
 *
 * しくみ
 *   - 管理者が、Google ドライブに置いた新しい PCInfoTool.exe を「設定」→「収集ツールの配布」で登録する
 *     （ドライブのファイルは、このウェブアプリを動かしているアカウントが開けること。共有は「制限付き」のままでよい）
 *   - 登録のときに SHA-256 を計算して ScriptProperties に持つ（シートには書かない）
 *   - ツール（v1.2.0 以降）は GET で問い合わせる
 *       .../exec?action=version&token=受信トークン   … {ok, version, sha256, notes, published}
 *       .../exec?action=download&token=受信トークン  … {ok, version, sha256, data(Base64)}
 *     トークンは、どれかの有効な顧客の「受信トークン」と同じときだけ答える
 *
 * 公開関数：getToolRelease / saveToolRelease（どちらも管理者だけ）
 * doGet からの入口は toolUpdateGet_（Code.gs）
 */

const RELEASE_PROPERTY = 'TOOL_RELEASE';
const RELEASE_MAX_BYTES = 5 * 1024 * 1024;    // 配る exe の上限。ダウンロードのたびに中身を読んで Base64 にするので小さめに（ps2exe の exe はふつう1MB未満）
const RELEASE_VERSION_MAX_PER_10MIN = 1000;   // 1顧客あたり、10分間に答える「版の問い合わせ」の回数
const RELEASE_DOWNLOAD_MAX_PER_10MIN = 30;    // 1顧客あたり、10分間に答えるダウンロードの回数

/** 登録されている配布の情報。無ければ null */
function readRelease_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RELEASE_PROPERTY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || !r.version || !r.fileId || !r.sha256) return null;
    return r;
  } catch (e) { return null; }
}

/** ドライブのファイルの URL か ID から、ファイルIDを取り出す */
function releaseFileId_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,100})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,100})/.exec(s) || /^([A-Za-z0-9_-]{10,100})$/.exec(s);
  return m ? m[1] : '';
}

/** 符号付きバイト列（-128〜127）の SHA-256 を、大文字の16進で */
function bytesSha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').toUpperCase();
}

/** 画面に見せる形（ファイルIDは管理者だけが見る画面なので出す） */
function releaseForClient_(r) {
  if (!r) return null;
  return { version: r.version, fileId: r.fileId, fileName: r.fileName || '', size: r.size || 0, sha256: r.sha256,
    notes: r.notes || '', published: r.published || '', by: r.by || '' };
}

/**
 * いま配っている版。
 * @param {{token:string}} params
 */
function getToolRelease(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    // v0.109.0：PCごとの収集ツールの版（最後に届いた版）を数える。古い版が残っていないか、入れ替わったかを見るため
    const versions = {};
    try {
      readTable_(SHEET_DIAGNOSTICS).rows.forEach(function (r) {
        const v = String(r['ツールバージョン'] || '').trim() || '不明';
        versions[v] = (versions[v] || 0) + 1;
      });
    } catch (e) { /* 数えられなくても、配布の情報は返す */ }
    return { release: releaseForClient_(readRelease_()), versions: versions };
  });
}

/**
 * 配る版を登録する。file を空にすると、配るのをやめる（ツールは更新しなくなる）。
 * @param {{token:string, file:string, version:string, notes:string}} params
 */
function saveToolRelease(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const props = PropertiesService.getScriptProperties();
    const fileText = typeof p.file === 'string' ? p.file.trim() : '';
    if (!fileText) {
      // 変更履歴はシートに書くので、ロックの中で（v0.19.0）
      return withLock_(function () {
        const before = readRelease_();
        props.deleteProperty(RELEASE_PROPERTY);
        if (before) logAudit_('収集ツールの配布を停止', 'v' + before.version, '', '', before.version, '', me.name);
        return { release: null };
      });
    }

    const fileId = releaseFileId_(fileText);
    if (!fileId) throw appError_('invalid', 'ドライブのファイルのURLかIDを入れてください。');
    const version = typeof p.version === 'string' ? p.version.trim() : '';
    if (!/^\d{1,5}(\.\d{1,5}){1,3}$/.test(version)) throw appError_('invalid', 'バージョンは 1.3.0 のように、数字とピリオドで入れてください。');
    const notes = cleanText_(typeof p.notes === 'string' ? p.notes : '', 300);

    let file;
    try { file = DriveApp.getFileById(fileId); } catch (err) {
      throw appError_('invalid', 'そのファイルを開けません。このアプリを動かしているアカウントのドライブにあるか（共有されているか）確かめてください。');
    }
    if (file.isTrashed && file.isTrashed()) throw appError_('invalid', 'そのファイルはゴミ箱に入っています。');
    const name = String(file.getName() || '');
    if (!/\.exe$/i.test(name)) throw appError_('invalid', '.exe のファイルを選んでください（いまのファイル名：' + name + '）。');
    const size = file.getSize();
    if (!size) throw appError_('invalid', 'ファイルが空です。');
    if (size > RELEASE_MAX_BYTES) throw appError_('invalid', 'ファイルが大きすぎます（5MBまで）。');

    const bytes = file.getBlob().getBytes();
    const release = {
      version: version, fileId: fileId, fileName: name, size: bytes.length, sha256: bytesSha256Hex_(bytes),
      notes: notes, published: nowStamp_(), by: me.name
    };
    return withLock_(function () {
      const before = readRelease_();
      props.setProperty(RELEASE_PROPERTY, JSON.stringify(release));
      logAudit_('収集ツールの配布を登録', 'v' + version, '', 'ファイル', before ? before.version : '', version + '（' + name + '）', me.name);
      return { release: releaseForClient_(release) };
    });
  });
}

/**
 * doGet の ?action=version / ?action=download（収集ツールからの問い合わせ）。
 * 画面のエラー文は出さず、いつも JSON で答える。
 */
function toolUpdateGet_(p) {
  const action = String(p.action || '');
  const deny = function (code) { return jsonOutput_({ ok: false, error: code }); };
  try {
    const token = typeof p.token === 'string' ? p.token : '';
    // v0.109.0：トークンなし（仮受付から入って、トークンを設定していないPC）でも、更新は受けられる。
    //   前は断っていたので、トークンの無いPCは「最新バージョンです」のまま入れ替わらなかった。
    //   配る exe は秘密ではない（中身はツールそのもの）。混雑を防ぐため、トークンなしは全体で回数を絞る。
    let rateId = '_anon';
    if (token) {
      if (!/^[0-9a-f]{64}$/.test(token)) return deny('unauthorized');
      const customer = readTable_(SHEET_CUSTOMERS).rows.filter(function (r) { return r['受信トークン'] === token; })[0];
      if (!customer || customer['状態'] !== '有効') return deny('unauthorized');
      rateId = String(customer['顧客ID']);
    }

    const isDownload = action === 'download';
    const cache = CacheService.getScriptCache();
    const rateKey = (isDownload ? 'updd_' : 'updv_') + rateId;
    const count = Number(cache.get(rateKey)) || 0;
    const limit = isDownload ? RELEASE_DOWNLOAD_MAX_PER_10MIN * (token ? 1 : 2) : RELEASE_VERSION_MAX_PER_10MIN * (token ? 1 : 3);
    if (count >= limit) return deny('busy');
    cache.put(rateKey, String(count + 1), 600);

    const r = readRelease_();
    if (!isDownload) {
      if (!r) return jsonOutput_({ ok: true, version: '' });     // 配っていない
      return jsonOutput_({ ok: true, version: r.version, sha256: r.sha256, notes: r.notes || '', published: r.published || '' });
    }
    if (!r) return deny('norelease');
    let bytes;
    try { bytes = DriveApp.getFileById(r.fileId).getBlob().getBytes(); } catch (err) {
      console.error('配布ファイルを読めません: ' + err);
      return deny('download');
    }
    // 登録のあとにファイルを差し替えられた場合は配らない（ツール側の検証でも止まるが、ここで先に止める）
    if (bytesSha256Hex_(bytes) !== r.sha256) {
      console.error('配布ファイルが登録のあとに変わっています。登録し直してください。');
      return deny('changed');
    }
    return jsonOutput_({ ok: true, version: r.version, sha256: r.sha256, data: Utilities.base64Encode(bytes) });
  } catch (err) {
    console.error('更新の問い合わせで予期しないエラー: ' + (err && err.stack ? err.stack : err));
    return deny('server');
  }
}

// =============================================================================
// ここから：元 Feed.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Feed.gs … Windows情報と Tips の自動更新のまとめ役（v0.76.0 で、ドライブの配信フォルダーは廃止した）
 *
 * いまの自動更新は RSS だけ（Rss.gs）。このファイルには、次のものがある。
 *   - addWinInfoRows_ … Windows情報をまとめて足す（RSS と「まとめて貼り付け」が使う）
 *   - addTipRows_ / tipsForClient_ … Tips の追加と、画面に渡す Tips
 *   - refreshFeed … 画面を開いたときに、裏で呼ばれる（新しい Tips を足す・RSS を読む）
 *
 * 取り込んだ Windows情報は、「顧客に見せる：いいえ」で入る。スタッフが確かめてから「はい」にする。
 *
 * 公開関数：refreshFeed
 */
const TIPS_CACHE_KEY = 'tips';

/**
 * Windows情報を、まとめてシートに足す（withLock_ の中で呼ぶこと）。同じ日付・同じタイトルのものは飛ばす。
 * @param {Array<Object>} items 画面や配信ファイルから来た値
 * @param {string} visible 「顧客に見せる」に入れる値
 * @return {{added:number, skipped:number, errors:Array<{line:number, message:string}>, firstId:string, lastId:string}}
 */
function addWinInfoRows_(items, visible, me) {
  const ent = ENTITIES.wininfo;
  const have = Object.create(null);
  readTable_(SHEET_WININFO).rows.forEach(function (r) { have[r['日付'] + '\n' + r['タイトル']] = true; });
  const records = [], errors = [];
  let skipped = 0;
  items.forEach(function (item, i) {
    try {
      if (!item) throw appError_('invalid', '「日付｜種類｜重要度｜タイトル」が足りません。');
      const values = validateEntity_('wininfo', Object.assign({}, item, { '顧客に見せる': visible }), null, me);
      if (!values['日付']) throw appError_('invalid', '日付は 2026-10-04 の形で入れてください。');
      const k = values['日付'] + '\n' + values['タイトル'];
      if (have[k]) { skipped++; return; }
      have[k] = true;
      records.push(values);
    } catch (e) {
      if (!e || !e.appCode) throw e;
      errors.push({ line: i + 1, message: e.message });
    }
  });
  const out = { added: records.length, skipped: skipped, errors: errors, firstId: '', lastId: '' };
  if (!records.length) return out;
  const now = nowStamp_();
  let n = Number(String(nextId_(SHEET_WININFO, '情報ID', ent.prefix, ent.digits)).slice(ent.prefix.length));
  const rows = records.map(function (v) {
    const rec = { '登録日時': now, '更新日時': now };
    let num = String(n++);
    while (num.length < ent.digits) num = '0' + num;
    rec['情報ID'] = ent.prefix + num;
    Object.keys(v).forEach(function (key) { rec[key] = v[key]; });
    return rec;
  });
  appendRecords_(SHEET_WININFO, rows);
  forgetSheet_(SHEET_WININFO);
  out.firstId = rows[0]['情報ID']; out.lastId = rows[rows.length - 1]['情報ID'];
  return out;
}

/**
 * Tips を、まとめてシートに足す（withLock_ の中で呼ぶこと）。同じ見出しのものは飛ばす。
 * @return {{added:number, full:number}} 足した数と、いっぱいで入れられなかった数
 */
function addTipRows_(tips) {
  const rows = readTable_(SHEET_TIPS).rows;
  const have = Object.create(null);
  rows.forEach(function (r) { have[String(r['見出し']).trim()] = true; });
  const room = Math.max(0, TIPS_MAX - rows.length);
  const fresh = [];
  let full = 0;
  tips.forEach(function (t) {
    const title = cleanText_(t[0]).replace(/\n/g, ' ').slice(0, TIPS_TITLE_MAX);
    const body = cleanText_(t[1]).replace(/\n/g, ' ').slice(0, TIPS_BODY_MAX);
    if (!title || !body || have[title]) return;
    if (fresh.length >= room) { full++; return; }
    have[title] = true;
    fresh.push([title, body]);
  });
  if (!fresh.length) return { added: 0, full: full };
  const now = nowStamp_();
  let n = Number(String(nextId_(SHEET_TIPS, 'TipID', 'T', 4)).slice(1));
  appendRecords_(SHEET_TIPS, fresh.map(function (t) {
    let num = String(n++);
    while (num.length < 4) num = '0' + num;
    return { 'TipID': 'T' + num, '見出し': t[0], '説明': t[1], '有効': YES, '登録日時': now };
  }));
  forgetSheet_(SHEET_TIPS);
  CacheService.getScriptCache().remove(TIPS_CACHE_KEY);
  return { added: fresh.length, full: full };
}

/**
 * 画面に渡す Tips [{t, b}]。Tips のシートから読む（1件も無ければ、最初から入っている文を使う）。
 * 開くたびにシートを読まないように、10分おぼえておく。
 */
function tipsForClient_(settings) {
  if (settings['Tipsを出す'] === NO) return [];
  const cache = CacheService.getScriptCache();
  const hit = cache.get(TIPS_CACHE_KEY);
  if (hit) {
    try { const list = JSON.parse(hit); if (Array.isArray(list) && list.length) return list; } catch (e) { /* 壊れていたら読み直す */ }
  }
  let list = [];
  try {
    list = readTable_(SHEET_TIPS).rows
      .filter(function (r) { return r['有効'] !== NO && String(r['見出し']).trim() && String(r['説明']).trim(); })
      .slice(0, TIPS_MAX)
      .map(function (r) { return { t: String(r['見出し']).slice(0, TIPS_TITLE_MAX), b: String(r['説明']).slice(0, TIPS_BODY_MAX) }; });
  } catch (e) { list = []; }
  if (!list.length) list = WINDOWS_TIPS.map(function (x) { return { t: x[0], b: x[1] }; });
  // キャッシュに入る大きさ（日本語は1文字が3バイトほど）のときだけ、おぼえておく。入らなくても、画面は出す
  const json = JSON.stringify(list);
  if (json.length < 30000) {
    try { cache.put(TIPS_CACHE_KEY, json, 600); } catch (e) { /* おぼえられなくても続ける */ }
  }
  return list;
}

/** RSS を確かめる間隔（秒）。設定「配信を確かめる間隔（時間）」1〜6、変なら6時間（force で読むときは待たない） */
function feedCheckSeconds_(settings) {
  const h = parseInt(settings && settings['配信を確かめる間隔（時間）'], 10);
  return isFinite(h) && h >= 1 && h <= 6 ? h * 3600 : 21600;
}

/** 管理画面に出す、自動更新（RSS）の状態 */
function feedForClient_(settings) {
  return { hours: feedCheckSeconds_(settings) / 3600,
    rss: { on: settings['RSSで自動取得する'] !== NO && settings['Windows情報を取り込む'] !== NO, status: rssStatus_() } };
}

/**
 * 廃止したものの残りを、1回だけ片づける（v0.76.0・v0.77.0）。スクリプトのプロパティ（配信フォルダーの記録・結果）と、設定シートの「配信フォルダー」の行。
 */
function dropOldFeedLeftovers_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FEED_CLEANED') === '2') return;
  props.deleteProperty('FEED_DONE');
  props.deleteProperty('FEED_STATUS');
  withLock_(function () {
    readTable_(SHEET_SETTINGS).rows.filter(function (r) { const k = String(r['キー']).trim(); return k === '配信フォルダー'; })
      .sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { deleteRecord_(SHEET_SETTINGS, r._row); });
  });
  props.setProperty('FEED_CLEANED', '2');
}

/**
 * 新しい Tips を足し、RSS を読む（毎朝の通知の処理と「いますぐ更新」。画面を開いたときには読まない。v0.77.0）。
 * @return {{added:number, tips:number, rss:Object, message:string}} added は足した Windows情報、tips は足した Tips
 */
function refreshFeedCore_(force) {
  let newTips = 0;
  try { dropOldFeedLeftovers_(); } catch (e) { console.error('配信フォルダーの残りを片づけられませんでした: ' + (e && e.message ? e.message : e)); }
  try { newTips = syncNewTips_(); } catch (e) { console.error('新しいTipsを足せませんでした: ' + (e && e.message ? e.message : e)); }
  const r = refreshRssCore_(force);
  return { added: r.added, tips: newTips, rss: r, message: r.message };
}

/**
 * 自動更新を確かめる（スタッフ）。画面を開いたときに、裏で呼ばれる。force:true は「いますぐ更新」。
 * @param {{token:string, force:boolean}} params
 */
function refreshFeed(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const r = refreshFeedCore_(p.force !== false);
    const settings = getSettings_();
    const out = { checked: r.rss.checked, added: r.added, addedTips: r.tips, message: r.message, feed: feedForClient_(settings) };
    // 何か足したときだけ、新しい一覧を返す
    out.wininfo = sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (x) { return publicRecord_(x); });
    out.tips = tipsForClient_(settings);
    return out;
  });
}

// =============================================================================
// ここから：元 Rss.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Rss.gs … Windows情報を、ニュースサイトの RSS から自動で取り込む（v0.73.0。v0.75.0 で言葉を設定にした）
 *
 * しくみ
 *   1. 下の RSS_SOURCES にある媒体の RSS を、アプリが直接読みにいく。
 *   2. 記事のタイトル・概要に、設定の「RSSの言葉」（不具合・ドライバー／セキュリティ／PCパーツ）が入っているものだけを選ぶ。
 *      どの媒体がどの言葉を使うかは、媒体ごとの groups で決める。言葉は設定で変えられる。
 *   3. 日付＋タイトルが同じものは入れない。入るのは「顧客に見せる：いいえ」（スタッフが確かめてから「はい」）。
 *   4. 確かめるのは、スタッフが画面を開いたとき（設定の間隔に1回まで）と、毎朝の通知の処理のとき。
 *
 * 使えないもの
 *   X（旧Twitter）… 無料で安定して使える RSS が無い。
 *   Windows リリース正常性 … Microsoft が RSS を出していない。代わりに、窓の杜・PC Watch・ITmedia の不具合の記事と、
 *   IPA・JPCERT/CC・Security NEXT・ITmedia セキュリティの記事を使う。
 *
 * 初回は、Apps Script の「外部サービスへの接続」の承認が1回だけ要る（メニュー「RSSを使えるようにする」）。
 *
 * 公開関数：authorizeRss（承認用）
 */
const RSS_CACHE_KEY = 'rssChecked';
const RSS_STATUS_PROPERTY = 'RSS_STATUS';
const RSS_MAX_AGE_DAYS = 14;        // これより古い記事は取り込まない
const RSS_MAX_TOTAL = 40;           // 1回に取り込む件数の上限
const RSS_MAX_BYTES = 1500000;      // 1つの RSS から読む大きさ（文字数）
const RSS_SEEN_PROPERTY = 'RSS_SEEN';   // 取り込んだ記事の印（日付＋タイトルの短い値）。スタッフが消した記事が、次の確認で戻ってこないように
const RSS_SEEN_MAX = 500;
const RSS_EXTRA_MAX = 3;            // 自分で足せる RSS の数
const RSS_URGENT_WORDS = /不具合|既知の問題|障害|緊急|ゼロデイ|脆弱性|悪用|サポート終了|終了|停止|起動しない|ブルースクリーン/;

// 設定の名前（言葉のグループ）。bug＝Windows の不具合・ドライバー、sec＝セキュリティ、parts＝PCパーツの価格・在庫
const RSS_WORD_SETTINGS = { bug: 'RSSの言葉（不具合・ドライバー）', sec: 'RSSの言葉（セキュリティ）', parts: 'RSSの言葉（PCパーツ）' };

// groups … その媒体で使う言葉のグループ。'all' は言葉で選ばない（全部取り込む）
const RSS_SOURCES = [
  { id: 'madonomori', name: '窓の杜', tag: '窓の杜', url: 'https://forest.watch.impress.co.jp/data/rss/1.0/wf/feed.rdf', groups: ['bug', 'sec'], max: 8 },
  { id: 'pcwatch', name: 'PC Watch', tag: 'PC Watch', url: 'https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf', groups: ['bug', 'sec', 'parts'], max: 8 },
  { id: 'pcuser', name: 'ITmedia PC USER', tag: 'PC USER', url: 'https://rss.itmedia.co.jp/rss/2.0/pcuser.xml', groups: ['bug', 'sec', 'parts'], max: 8 },
  { id: 'jpcert', name: 'JPCERT/CC', tag: 'JPCERT', url: 'https://www.jpcert.or.jp/rss/jpcert.rdf', groups: ['sec'], max: 6 },
  { id: 'ipa', name: 'IPA 重要なセキュリティ情報', tag: 'IPA', url: 'https://www.ipa.go.jp/security/alert-rss.rdf', groups: ['sec'], max: 5 },
  { id: 'securitynext', name: 'Security NEXT', tag: 'SecNEXT', url: 'https://www.security-next.com/feed', groups: ['sec'], max: 6 },
  { id: 'itmsec', name: 'ITmedia セキュリティ', tag: 'ITmedia', url: 'https://rss.itmedia.co.jp/rss/2.0/news_security.xml', groups: ['sec'], max: 6 },
  { id: 'akiba', name: 'AKIBA PC Hotline!', tag: 'AKIBA', url: 'https://akiba-pc.watch.impress.co.jp/data/rss/1.0/ah/feed.rdf', groups: ['parts'], max: 8 }
];

/** XML の文字を、ふつうの文字にする（CDATA・文字参照・タグ） */
function rssText_(s) {
  const decode = function (t) {
    return t.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  };
  // 本文が &lt;p&gt; のように入っている RSS が多いので、「タグを取る→文字参照を戻す」を2回する
  const strip = function (t) { return t.replace(/<[^>]*>/g, ' '); };
  const raw = String(s === null || s === undefined ? '' : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(strip(decode(strip(raw)))).replace(/\s+/g, ' ').trim();
}

function rssTag_(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? m[1] : '';
}

/** RSS 1.0 / 2.0 の記事を取り出す。[{title, link, date:'yyyy-MM-dd', desc, stamp}]（日付が読めないものは捨てる） */
function parseRss_(xml) {
  const out = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  const text = String(xml || '').slice(0, RSS_MAX_BYTES);
  let m;
  const tz = scriptTz_();
  while ((m = re.exec(text)) && out.length < 400) {
    const b = m[1];
    const title = rssText_(rssTag_(b, 'title'));
    let link = rssText_(rssTag_(b, 'link')) || rssText_(rssTag_(b, 'guid'));
    const when = new Date(rssText_(rssTag_(b, 'dc:date')) || rssText_(rssTag_(b, 'pubDate')) || rssText_(rssTag_(b, 'a10:updated')));
    if (!title || isNaN(when.getTime())) continue;
    if (!WININFO_LINK.test(link)) link = '';
    out.push({ title: title, link: link, desc: rssText_(rssTag_(b, 'description') || rssTag_(b, 'content:encoded')), stamp: when.getTime(), date: Utilities.formatDate(when, tz, 'yyyy-MM-dd') });
  }
  if (!out.length) {
    // Atom（<entry>）の形も読む
    const reA = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
    while ((m = reA.exec(text)) && out.length < 400) {
      const b = m[1];
      const title = rssText_(rssTag_(b, 'title'));
      let link = '';
      (b.match(/<link\b[^>]*>/gi) || []).forEach(function (tag) {
        const href = /href=["']([^"']+)["']/i.exec(tag), rel = /rel=["']([^"']+)["']/i.exec(tag);
        if (href && !link && (!rel || rel[1] === 'alternate')) link = rssText_(href[1]);
      });
      const when = new Date(rssText_(rssTag_(b, 'updated')) || rssText_(rssTag_(b, 'published')));
      if (!title || isNaN(when.getTime())) continue;
      if (!WININFO_LINK.test(link)) link = '';
      out.push({ title: title, link: link, desc: rssText_(rssTag_(b, 'summary') || rssTag_(b, 'content')), stamp: when.getTime(), date: Utilities.formatDate(when, tz, 'yyyy-MM-dd') });
    }
  }
  return out;
}

/** 種類を決める */
function rssKind_(text) {
  if (/ドライバ|driver|BIOS|ファームウェア|firmware/i.test(text)) return 'ドライバー';
  if (/KB\d{6,8}|更新プログラム|Windows Update|セキュリティ更新|パッチ|脆弱性|アップデート|CVE-/i.test(text)) return '更新プログラム';
  return 'その他';
}

/** 設定の除外ワード（カンマ区切り）に当たるか */
function rssExcluded_(text, words) {
  return words.some(function (w) { return w && text.toLowerCase().indexOf(w.toLowerCase()) !== -1; });
}

/** 設定の言葉（カンマ・読点・改行で区切る）を、配列にする */
function rssWordList_(v) {
  return String(v || '').split(/[,、，\n]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; }).slice(0, 60);
}

/** 本文に、言葉のどれかが入っているか（大文字小文字は区別しない） */
function rssHasWord_(text, words) {
  const t = String(text).toLowerCase();
  return words.some(function (w) { return t.indexOf(w.toLowerCase()) !== -1; });
}

/** その媒体で使う言葉（設定のグループをまとめたもの）。['all'] は全部取り込む */
function rssKeepWords_(src, settings) {
  if (src.groups.indexOf('all') !== -1) return null;
  let words = [];
  src.groups.forEach(function (g) { words = words.concat(rssWordList_(settings[RSS_WORD_SETTINGS[g]])); });
  return words;
}

/** 1つの媒体の記事を、Windows情報の形にする。 */
function rssPick_(src, items, excluded, keepWords) {
  const base = new Date(todayYmd_() + 'T23:59:59+09:00').getTime();      // 今日の終わり（日本時間）
  const since = base - RSS_MAX_AGE_DAYS * 86400000;
  const ahead = base + 2 * 86400000;
  const fresh = items.filter(function (x) {
    return x.stamp >= since && x.stamp <= ahead && !rssExcluded_(x.title, excluded) &&
      (keepWords === null || rssHasWord_(x.title + ' ' + x.desc.slice(0, 120), keepWords));
  }).sort(function (a, b) { return b.stamp - a.stamp; });
  return fresh.slice(0, src.max).map(function (x) {
    return { '日付': x.date, '種類': rssKind_(x.title + ' ' + x.desc.slice(0, 120)), '重要度': RSS_URGENT_WORDS.test(x.title) ? '重要' : '通常',
      'タイトル': ('【' + src.tag + '】' + x.title).slice(0, 60), '内容': x.desc.slice(0, 300), 'リンク': x.link };
  });
}

function rssStatus_() {
  let st = null;
  try { st = JSON.parse(PropertiesService.getScriptProperties().getProperty(RSS_STATUS_PROPERTY) || 'null'); } catch (e) { st = null; }
  if (!st || typeof st !== 'object') return null;
  return { at: String(st.at || ''), ok: !!st.ok, message: String(st.message || ''), added: Number(st.added) || 0,
    sources: (Array.isArray(st.sources) ? st.sources : []).slice(0, 12).map(function (s) { return { name: String(s.name || ''), ok: !!s.ok, n: Number(s.n) || 0, err: String(s.err || '') }; }) };
}

/** 使う媒体。設定の「RSSを止める媒体」に入っている言葉が、名前かIDに入る媒体は外す。「RSSの追加URL」の RSS を足す */
function rssSources_(settings) {
  const off = rssWordList_(settings['RSSを止める媒体']);
  const list = RSS_SOURCES.filter(function (x) { return !rssHasWord_(x.id + ' ' + x.name + ' ' + x.tag, off); });
  rssWordList_(String(settings['RSSの追加URL'] || '').replace(/\s+/g, ',')).slice(0, RSS_EXTRA_MAX).forEach(function (u, i) {
    if (!WININFO_LINK.test(u)) return;
    const host = (/^https:\/\/([^\/]+)/.exec(u) || [])[1] || '追加';
    list.push({ id: 'extra' + (i + 1), name: '追加したRSS（' + host + '）', tag: host.replace(/^www\./, '').slice(0, 14), url: u, groups: ['all'], max: 5 });
  });
  return list;
}

/**
 * RSS を読んで、Windows情報に足す。
 * @return {{on:boolean, checked:boolean, added:number, message:string}}
 */
function refreshRssCore_(force) {
  const settings = getSettings_();
  const none = { on: false, checked: false, added: 0, message: '' };
  if (settings['RSSで自動取得する'] === NO || settings['Windows情報を取り込む'] === NO) return none;
  const cache = CacheService.getScriptCache();
  if (!force && cache.get(RSS_CACHE_KEY)) return { on: true, checked: false, added: 0, message: '' };
  cache.put(RSS_CACHE_KEY, '1', feedCheckSeconds_(settings));
  const words = rssWordList_(settings['RSSの除外ワード']);
  const showInfo = settings['取り込んだWindows情報をお客様に見せる'] === YES ? YES : NO;
  const props = PropertiesService.getScriptProperties();

  // 媒体を全部いっしょに読む（順番に読むと遅い）。fetchAll が丸ごと失敗したら、1つずつ読み直して、どこがだめか分ける
  const sources = rssSources_(settings);
  const request = function (src) { return { url: src.url, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PCKanri-RSS)' } }; };
  let responses = null;
  try { responses = UrlFetchApp.fetchAll(sources.map(request)); } catch (e) { responses = null; }
  const picked = [], report = [];
  sources.forEach(function (src, i) {
    try {
      const res = responses ? responses[i] : UrlFetchApp.fetch(src.url, request(src));
      const code = res.getResponseCode();
      if (code < 200 || code >= 300) throw new Error('HTTP ' + code);
      const items = rssPick_(src, parseRss_(res.getContentText('UTF-8')), words, rssKeepWords_(src, settings));
      items.forEach(function (x) { picked.push(x); });
      report.push({ name: src.name, ok: true, n: items.length });
    } catch (e) {
      console.error('RSSを読めませんでした（' + src.name + '）: ' + (e && e.message ? e.message : e));
      report.push({ name: src.name, ok: false, n: 0, err: String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 120) });
    }
  });
  const okCount = report.filter(function (r) { return r.ok; }).length;
  const save = function (ok, message, added) {
    props.setProperty(RSS_STATUS_PROPERTY, JSON.stringify({ at: nowStamp_(), ok: ok, message: message, added: added, sources: report }));
    return { on: true, checked: true, added: added, message: message };
  };
  if (!okCount) {
    const first = (report[0] && report[0].err) || '';
    const perm = /permission|権限|authori|承認|script\.external_request/i.test(first);
    return save(false, perm ? '外部サービスへの接続が承認されていません。メニュー「' + APP_NAME + '」→「RSSを使えるようにする」を実行してください。' : 'RSSを読めませんでした。理由：' + first, 0);
  }
  const me = { id: 'rss', name: 'RSS自動取得', role: ROLE_STAFF, isAdmin: false };
  // 前に取り込んだ記事（スタッフが消したものも）は、もう入れない。重要なもの・新しいものを先にして、件数の上限で切る
  let seen = [];
  try { seen = JSON.parse(props.getProperty(RSS_SEEN_PROPERTY) || '[]'); } catch (e) { seen = []; }
  if (!Array.isArray(seen)) seen = [];
  const seenSet = Object.create(null);
  seen.forEach(function (k) { seenSet[k] = true; });
  const mark = function (x) { return sha256Hex_(x['日付'] + '\n' + x['タイトル']).slice(0, 10); };
  const fresh = picked.filter(function (x) { return !seenSet[mark(x)]; })
    .sort(function (a, b) { return (b['重要度'] === '重要') - (a['重要度'] === '重要') || (a['日付'] < b['日付'] ? 1 : a['日付'] > b['日付'] ? -1 : 0); })
    .slice(0, RSS_MAX_TOTAL);
  return withLock_(function () {
    {
      const r = addWinInfoRows_(fresh, showInfo, me);
      if (r.added) logAudit_('RSSの取り込み', 'Windows情報', '', '', '', r.added + '件', me.name);
      fresh.forEach(function (x) { const k = mark(x); if (!seenSet[k]) { seenSet[k] = true; seen.push(k); } });
      props.setProperty(RSS_SEEN_PROPERTY, JSON.stringify(seen.slice(-RSS_SEEN_MAX)));
      const ng = report.length - okCount;
      return save(true, 'RSS ' + okCount + '媒体を読み、Windows情報を ' + r.added + '件足しました。' + (ng ? '（読めなかった媒体 ' + ng + '）' : ''), r.added);
    }
  });
}

/**
 * 「外部サービスへの接続」の承認を出す（v0.73.1）。スプレッドシートのメニュー、または Apps Script のエディタで
 * この関数を選んで「実行」すると、承認の画面が出る。承認したあと、窓の杜の RSS を1回読んで、結果を知らせる。
 */
function authorizeRss() {
  let msg;
  try {
    const res = UrlFetchApp.fetch(RSS_SOURCES[0].url, { muteHttpExceptions: true });
    msg = '外部サービスへの接続は使えます（' + RSS_SOURCES[0].name + ' の応答：' + res.getResponseCode() + '）。RSS は、画面を開いたときと毎朝の処理で自動で読まれます。';
  } catch (e) {
    console.error('外部接続の権限を確かめられませんでした: ' + (e && e.stack ? e.stack : e));
    msg = '外部サービスへ接続できませんでした。\n' + String(e && e.message ? e.message : e).slice(0, 200);
  }
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* エディタやウェブからは画面が使えない。ログだけ */ }
}
