/**
 * Records.gs … 顧客・機器・ライセンス・対応履歴・修理案件・認証情報の登録と編集
 *
 * 入力チェックは Config.gs の ENTITIES の定義に沿って validateEntity_() がまとめて行う。
 * 公開関数はどれも「トークンで本人確認 → ロック → 読み直し → チェック → 書き込み → 変更履歴」の順。
 *
 * 公開関数：saveCustomer / saveDevice / saveLicense / saveActivity / saveRepair / saveCredential
 *           deleteActivity / deleteRepair / deleteLicense / deleteCredential
 *           addAllocation / removeAllocation / listCredentials / revealCredential
 *           addOption / setOptionActive / saveSettings / issuePortalToken / getPortalUrl
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Records.gs'] = '0.143.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

// ---------------------------------------------------------------------------
// 入力の整え
// ---------------------------------------------------------------------------
/** 制御文字を落として前後の空白を取る。max を渡すとその長さで切る */
function cleanText_(v, max) {
  let s = String(v === null || v === undefined ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function canSeeSecrets_(me, settings) {
  return me.isAdmin || settings['スタッフに認証情報を見せる'] !== NO;
}

function activeStaffNames_() {
  return refPart_('refStaff').filter(function (s) { return s.enabled; }).map(function (s) { return s.name; });
}

/**
 * 1項目を検証して、シートに入れる形（文字か数値）にそろえる。
 * @param {Object} f       ENTITIES の項目定義
 * @param {*} raw          画面から来た値
 * @param {*} current      編集の時の今の値（新規なら ''）
 * @param {Object} ctx     {options, staffNames}
 */
function normalizeField_(f, raw, current, ctx) {
  const bad = function (msg) { return appError_('invalid', '「' + f.name + '」' + msg); };
  const cur = String(current === null || current === undefined ? '' : current);
  switch (f.type) {
    case 'text':
    case 'secret': {
      const s = cleanText_(raw).replace(/\n/g, ' ');
      if (f.max && s.length > f.max) throw bad('は' + f.max + '文字までです。');
      return s;
    }
    case 'phones': {
      // v0.143.0：電話番号をいくつも（1行に1つ。「修理受付：0120-…」のように名前も付けられる）
      const lines = cleanText_(raw).split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l; });
      if (lines.length > 10) throw bad('は10件までです。');
      if (lines.some(function (l) { return l.length > 80; })) throw bad('は1件80文字までです。');
      const s = lines.join('\n');
      if (f.max && s.length > f.max) throw bad('は' + f.max + '文字までです。');
      return s;
    }
    case 'longtext': {
      const s = cleanText_(raw);
      if (f.max && s.length > f.max) throw bad('は' + f.max + '文字までです。');
      return s;
    }
    case 'date': {
      const s = cleanText_(raw);
      if (!s) return '';
      const d = parseYmd_(s);
      if (!d) throw bad('の日付が正しくありません。');
      return d;
    }
    case 'datetime': {
      const s = cleanText_(raw);
      if (!s) return '';
      const d = parseYmdHm_(s);
      if (!d) throw bad('の日時が正しくありません。');
      return d;
    }
    case 'number': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (!/^\d{1,9}$/.test(s)) throw bad('は0以上の整数で入れてください。');
      const n = Number(s);
      if (f.max && n > f.max) throw bad('は' + f.max + '以下にしてください。');
      return n;
    }
    case 'select': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (f.choices.indexOf(s) === -1) throw bad('の値が選択肢にありません。');
      return s;
    }
    case 'yesno': {
      const s = cleanText_(raw) || NO;      // 空は「いいえ」（後から足した列は、前からある行では空のため。v0.99.0）
      if (s !== YES && s !== NO) throw bad('は「はい」か「いいえ」です。');
      return s;
    }
    case 'multi': {
      const list = Array.isArray(raw) ? raw.map(String) : cleanText_(raw).split(',');
      const picked = list.map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      picked.forEach(function (x) {
        if (f.choices.indexOf(x) === -1) throw bad('の値が選択肢にありません。');
      });
      return f.choices.filter(function (c) { return picked.indexOf(c) !== -1; }).join(',');
    }
    case 'option': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (s === cur) return s; // 今は使っていない選択肢でも、編集のたびに弾かない
      const ok = (ctx.options[f.category] || []).some(function (o) { return o.active && o.value === s; });
      if (!ok) throw bad('の値が選択肢にありません。設定の「選択肢」で足してください。');
      return s;
    }
    case 'staff': {
      const s = cleanText_(raw).replace(/\n/g, ' ');
      if (!s || s === cur) return s;
      if (ctx.staffNames.indexOf(s) === -1) throw bad('はスタッフから選んでください。');
      return s;
    }
    case 'customer':
    case 'device':
    case 'rental':
    case 'project':
    case 'deal':
      return cleanText_(raw);
    default:
      throw appError_('server', '項目の定義が正しくありません。');
  }
}

/**
 * 画面から来たデータを検証する。
 * @return {Object} 変える（新規なら入れる）項目だけを持つ {項目名: 値}
 */
function validateEntity_(key, data, existing, me, ctx0) {
  const ent = ENTITIES[key];
  const ctx = ctx0 || { options: getOptions_(), staffNames: activeStaffNames_() };
  const values = {};
  ent.fields.forEach(function (f) {
    if (f.adminOnly && !me.isAdmin) {
      if (!existing) values[f.name] = f.def || '';
      return;
    }
    let raw = data[f.name];
    if (raw === undefined) {
      if (existing) return; // 編集で渡されなかった項目は変えない
      raw = f.def === 'today' ? todayYmd_() : f.def === 'me' ? me.name : (f.def || '');
    }
    const current = existing ? existing[f.name] : '';
    const v = normalizeField_(f, raw, current, ctx);
    if (f.required && v === '') throw appError_('invalid', '「' + f.name + '」を入れてください。');
    values[f.name] = v;
  });

  // 新規・編集のどちらでも、最終的な値で整合を見る
  const merged = {};
  ent.fields.forEach(function (f) {
    merged[f.name] = values[f.name] !== undefined ? values[f.name] : (existing ? existing[f.name] : '');
  });

  // 顧客
  if (merged['顧客ID'] !== undefined && key !== 'customer' && merged['顧客ID'] !== '') {
    if (!cachedFind_('customers', SHEET_CUSTOMERS, '顧客ID', merged['顧客ID'])) throw appError_('invalid', '顧客が見つかりません。');
    if (existing && (key === 'device' || key === 'license' || key === 'credential') &&
        String(existing['顧客ID']) !== String(merged['顧客ID'])) {
      throw appError_('invalid', ent.label + 'の顧客は後から変えられません。新しく登録し直してください。');
    }
  }
  // 機器（その顧客の機器だけ）
  if (merged['機器ID']) {
    const dev = cachedFind_('devices', SHEET_DEVICES, '機器ID', merged['機器ID']);
    if (!dev || String(dev['顧客ID']) !== String(merged['顧客ID'])) {
      throw appError_('invalid', '機器は、選んだ顧客のものから選んでください。');
    }
  }
  if (key === 'repair') {
    if (merged['元の対応ID']) {
      const act = findById_(SHEET_ACTIVITIES, '対応ID', merged['元の対応ID']);
      if (!act || String(act['顧客ID']) !== String(merged['顧客ID'])) {
        throw appError_('invalid', '「元の対応ID」は、同じ顧客の対応履歴のIDを入れてください。');
      }
    }
    if (merged['ステータス'] === REPAIR_DONE && !merged['完了日']) values['完了日'] = merged['完了日'] = todayYmd_();
    if (merged['完了日'] && merged['受付日'] && merged['完了日'] < merged['受付日']) {
      throw appError_('invalid', '完了日が受付日より前になっています。');
    }
  }
  if (key === 'activity') {
    // v0.133.0：完了にしたのに完了日時が空なら、今の日時を入れる（修理の完了日と同じ）
    if (merged['ステータス'] === ACTIVITY_DONE && !merged['完了日時'] && ent.fields.some(function (f) { return f.name === '完了日時'; })) {
      values['完了日時'] = merged['完了日時'] = nowStamp_();
    }
    if (merged['開始日時'] && merged['完了日時'] && merged['完了日時'] < merged['開始日時']) {
      throw appError_('invalid', '完了日時が開始日時より前になっています。');
    }
  }
  if (key === 'loan') {
    const rental = findById_(SHEET_RENTALS, 'レンタルID', merged['レンタルID']);
    if (!rental) throw appError_('invalid', 'レンタル機器が見つかりません。');
    if (existing && String(existing['レンタルID']) !== String(merged['レンタルID'])) {
      throw appError_('invalid', '貸出記録のレンタル機器は後から変えられません。新しく登録し直してください。');
    }
    if (!merged['顧客ID'] && !merged['貸出先']) throw appError_('invalid', '「顧客」か「現場名」のどちらかを入れてください。');
    if (merged['返却予定日'] && merged['返却予定日'] < merged['貸出日']) throw appError_('invalid', '返却予定日が貸出日より前になっています。');
    if (merged['返却日'] && merged['返却日'] < merged['貸出日']) throw appError_('invalid', '返却日が貸出日より前になっています。');
    if (!merged['返却日']) {
      const selfId = existing ? String(existing['貸出ID']) : '';
      const busy = readTable_(SHEET_LOANS).rows.some(function (l) {
        return String(l['レンタルID']) === String(merged['レンタルID']) && !l['返却日'] && String(l['貸出ID']) !== selfId;
      });
      if (busy) throw appError_('invalid', 'この機器は貸出中です。先に返却を記録してください。');
      if (!existing && rental['状態'] !== RENTAL_AVAILABLE) throw appError_('invalid', 'この機器は「' + rental['状態'] + '」なので貸し出せません。');
    }
    if (merged['修理ID'] && !findById_(SHEET_REPAIRS, '修理ID', merged['修理ID'])) throw appError_('invalid', '「修理ID」の修理案件が見つかりません。');
  }
  // 開発案件・商談（テスト版。v0.81.0）
  if (merged['案件ID'] && (key === 'activity' || key === 'saleslog')) {
    const pj = findById_(SHEET_PROJECTS, '案件ID', merged['案件ID']);
    if (!pj) throw appError_('invalid', '「案件」が見つかりません。');
    if (key === 'activity' && String(pj['顧客ID']) !== String(merged['顧客ID'])) throw appError_('invalid', '「案件」は、同じ顧客の開発案件から選んでください。');
  }
  if (key === 'project') {
    ['スプレッドシートURL', 'WebアプリのURL'].forEach(function (n) {
      if (merged[n] && !WININFO_LINK.test(merged[n])) throw appError_('invalid', '「' + n + '」は https:// で始まるURLを入れてください。');
    });
    if (merged['開始日'] && merged['納期'] && merged['納期'] < merged['開始日']) throw appError_('invalid', '納期が開始日より前になっています。');
    if (!merged['顧客ID'] && PROJECT_SALES.concat([PROJECT_LOST, PROJECT_HOLD]).indexOf(merged['状態']) === -1) {
      throw appError_('invalid', '「' + merged['状態'] + '」にするには顧客が必要です。一覧の「受注（顧客にする）」を使うか、顧客を選んでください。');
    }
  }
  if (key === 'saleslog' && !merged['相手先'] && !merged['顧客ID'] && !merged['案件ID']) {
    throw appError_('invalid', '「相手先」「顧客」「案件」のどれかを入れてください。');
  }
  if (key === 'wininfo') {
    if (merged['リンク'] && !WININFO_LINK.test(merged['リンク'])) throw appError_('invalid', '「リンク」は https:// で始まるURLを入れてください。');
  }
  if (key === 'credential') {
    const kind = merged['対象区分'];
    const target = merged['対象ID'];
    if (kind === 'その他') {
      if (target) values['対象ID'] = '';
    } else if (target) {
      const row = kind === '機器'
        ? findById_(SHEET_DEVICES, '機器ID', target)
        : findById_(SHEET_LICENSES, 'ライセンスID', target);
      if (!row || String(row['顧客ID']) !== String(merged['顧客ID'])) {
        throw appError_('invalid', '「対象ID」は、同じ顧客の' + kind + 'から選んでください。');
      }
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// 画面に渡す形
// ---------------------------------------------------------------------------
function toClient_(key, row) {
  if (key === 'customer') {
    const c = publicRecord_(row, ['ポータルトークン', '受信トークン']);
    c['ポータル発行済'] = !!row['ポータルトークン'];
    c['受信発行済'] = !!row['受信トークン'];
    return c;
  }
  if (key === 'credential') {
    const c = publicRecord_(row, ['パスワード', 'シリアルキー']);
    c['パスワードあり'] = !!row['パスワード'];
    c['シリアルキーあり'] = !!row['シリアルキー'];
    return c;
  }
  return publicRecord_(row);
}

function isSecretField_(key, name) {
  return ENTITIES[key].fields.some(function (f) { return f.name === name && f.type === 'secret'; });
}

function customerIdOf_(key, row) {
  return key === 'customer' ? row[ENTITIES.customer.idField] : (row['顧客ID'] || '');
}

// ---------------------------------------------------------------------------
// v0.140.0：韓国語（ハングル）の文を、保存の時に日本語に訳す（設定「韓国語を日本語に訳す」）
//   ハングルのある行だけを訳す（日本語の行はそのまま）。長い文の欄は、下に原文も残す。
//   すでに訳した文（原文の印がある）を直した時は、印より上の新しいハングルの行だけを訳し、原文の所に足す
// ---------------------------------------------------------------------------
const TRANSLATE_KEYS = { activity: true, repair: true, maintenance: true, memo: true };
const HANGUL_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
const TRANSLATE_MARK = '――― 原文（韓国語）―――';
/** お客様に見せる文から、原文（韓国語）の所を外す（お客様ページ・月次レポート） */
function withoutOriginal_(v) {
  const s = String(v === null || v === undefined ? '' : v);
  const at = s.indexOf(TRANSLATE_MARK);
  return at === -1 ? s : s.slice(0, at).replace(/\s+$/, '');
}
function forCustomer_(rec) {
  ['内容', '件名'].forEach(function (k) { if (rec && typeof rec[k] === 'string') rec[k] = withoutOriginal_(rec[k]); });
  return rec;
}
/**
 * v0.142.0：翻訳の言い換え。[前, 後]
 *   前がハングル … 訳す前に置き換える（PC の言葉を、決まった日本語にしておく）
 *   前が日本語など … 訳した後に置き換える（機械翻訳が出しがちな言い方を、ふだんの言い方に直す）
 * 設定の「選択肢」→「翻訳の言い換え」に「前=後」で足せる（足したものが先に効く）
 */
const TRANSLATE_GLOSSARY = [
  // 訳す前（韓国語 → 日本語の言葉）
  ['윈도우 업데이트', 'Windows Update'], ['윈도우업데이트', 'Windows Update'], ['윈도우', 'Windows'], ['재부팅', '再起動'], ['리부팅', '再起動'],
  ['백신', 'ウイルス対策ソフト'], ['공유기', 'ルーター'], ['라우터', 'ルーター'], ['복합기', '複合機'], ['프린터', 'プリンター'], ['드라이버', 'ドライバー'],
  ['공유 폴더', '共有フォルダー'], ['공유폴더', '共有フォルダー'], ['노트북', 'ノートPC'], ['데스크탑', 'デスクトップPC'], ['데스크톱', 'デスクトップPC'],
  ['랜선', 'LANケーブル'], ['랜 케이블', 'LANケーブル'], ['와이파이', 'Wi-Fi'], ['아웃룩', 'Outlook'], ['엑셀', 'Excel'], ['파워포인트', 'PowerPoint'],
  ['오피스', 'Office'], ['원격 지원', 'リモートサポート'], ['원격지원', 'リモートサポート'], ['용지 걸림', '紙詰まり'], ['토너', 'トナー'],
  ['비밀번호', 'パスワード'], ['이메일', 'メール'], ['백업', 'バックアップ'], ['정기 점검', '定期点検'], ['정기점검', '定期点検'], ['견적', '見積もり'],
  // 訳した後（日本語の言い方をそろえる）
  ['リブート', '再起動'], ['再起動を行いました', '再起動しました'], ['ウィンドウズ', 'Windows'], ['ワクチン', 'ウイルス対策ソフト'], ['共有器', 'ルーター'],
  ['ノートブック', 'ノートPC'], ['プリンタ ', 'プリンター '], ['プリンタ。', 'プリンター。'], ['ドライバ ', 'ドライバー '], ['ドライバ。', 'ドライバー。'],
  ['複写機', '複合機'], ['顧客様', 'お客様'], ['お客さん', 'お客様'], ['ランケーブル', 'LANケーブル'], ['ワイファイ', 'Wi-Fi'], ['用紙詰まり', '紙詰まり']
];
function translateGlossary_() {
  let extra = [];
  try {
    extra = ((getOptions_() || {})['翻訳の言い換え'] || []).filter(function (o) { return o.active !== false; }).map(function (o) {
      const m = /^(.+?)\s*[=＝]\s*(.*)$/.exec(String(o.value || ''));
      return m ? [m[1].trim(), m[2].trim()] : null;
    }).filter(function (x) { return x && x[0]; });
  } catch (e) { extra = []; }
  const all = extra.concat(TRANSLATE_GLOSSARY);
  // 長いものから置き換える（「윈도우 업데이트」を「윈도우」より先に）
  const sortLen = function (a, b) { return b[0].length - a[0].length; };
  return {
    pre: all.filter(function (g) { return HANGUL_RE.test(g[0]); }).sort(sortLen),
    post: all.filter(function (g) { return !HANGUL_RE.test(g[0]); }).sort(sortLen)
  };
}
function replaceAll_(s, pairs) {
  pairs.forEach(function (g) { s = s.split(g[0]).join(g[1]); });
  return s;
}
function koToJa_(lines, gloss) {
  if (!lines.length) return [];
  gloss = gloss || { pre: [], post: [] };
  const pre = lines.map(function (l) { return replaceAll_(l, gloss.pre); });
  // 置き換えでハングルが無くなった行は、訳さない
  const need = [];
  pre.forEach(function (l, i) { if (HANGUL_RE.test(l)) need.push(i); });
  const out = pre.slice();
  if (need.length) {
    const src = need.map(function (i) { return pre[i]; });
    let got = String(LanguageApp.translate(src.join('\n'), 'ko', 'ja') || '').split('\n');
    if (got.length !== src.length) got = src.map(function (l) { return String(LanguageApp.translate(l, 'ko', 'ja') || l); });      // 行の数が合わない時は、1行ずつ
    need.forEach(function (i, n) { out[i] = got[n]; });
  }
  return out.map(function (l) { return replaceAll_(l, gloss.post); });
}
/** @param {Object=} prev 直す前の記録（あれば、前と同じ行は訳し直さない。訳した後もハングルが残る行（名前など）を、直すたびに訳さないため） */
function translateKorean_(key, data, settings, prev) {
  if (!TRANSLATE_KEYS[key] || !data || (settings && settings['韓国語を日本語に訳す'] === NO)) return [];
  const done = [];
  let gloss = null;
  ENTITIES[key].fields.forEach(function (f) {
    if (f.type !== 'longtext' && f.name !== '件名') return;
    const v = data[f.name];
    if (typeof v !== 'string' || !HANGUL_RE.test(v)) return;
    const at = v.indexOf(TRANSLATE_MARK);
    const head = at === -1 ? v : v.slice(0, at);
    const tail = at === -1 ? '' : v.slice(at + TRANSLATE_MARK.length).replace(/^\n+/, '').replace(/\s+$/, '');
    const lines = head.replace(/\s+$/, '').split('\n');
    const same = {};
    if (prev && typeof prev[f.name] === 'string') String(prev[f.name]).split(TRANSLATE_MARK)[0].split('\n').forEach(function (l) { same[l] = true; });
    const idx = [];
    lines.forEach(function (l, i) { if (HANGUL_RE.test(l) && !same[l]) idx.push(i); });
    if (!idx.length) return;
    let ja;
    try { gloss = gloss || translateGlossary_(); ja = koToJa_(idx.map(function (i) { return lines[i]; }), gloss); } catch (e) { console.warn('翻訳できませんでした（そのまま保存します）: ' + e); return; }
    const orig = idx.map(function (i) { return lines[i]; });
    idx.forEach(function (i, n) { lines[i] = ja[n] || lines[i]; });
    let out = lines.join('\n');
    if (f.type === 'longtext') {
      const full = out + '\n\n' + TRANSLATE_MARK + '\n' + (tail ? tail + '\n' : '') + orig.join('\n');
      if (full.length <= (f.max || 5000)) out = full;
    }
    data[f.name] = out;
    done.push(f.name);
  });
  return done;
}

/** シートが無ければ、見出しだけのシートを作る（withLock_ の中で呼ぶ。v0.142.0） */
function ensureSheet_(sheetName) {
  const ss = getSs_();
  if (ss.getSheetByName(sheetName)) return;
  const wanted = SCHEMA[sheetName].map(function (c) { return c[0]; });
  const sheet = ss.insertSheet(sheetName, ss.getNumSheets());
  sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
  forgetSheet_(sheetName);
}

// ---------------------------------------------------------------------------
// 登録・編集の共通処理
// ---------------------------------------------------------------------------
function saveEntity_(key, params, after) {
  const p = params || {};
  const me = requireSession_(p.token);
  const ent = ENTITIES[key];
  const data = p.data && typeof p.data === 'object' ? p.data : {};
  const id = cleanText_(data[ent.idField]);

  // 選択肢とスタッフの名前は、ロックの前に控えから読んでおく（v0.18.0。ロックの中でシートを読まない）
  const ctx0 = { options: getOptions_(), staffNames: activeStaffNames_() };
  const tStart = Date.now();
  let translated = [];      // ロックの前に訳す（v0.140.0）
  if (TRANSLATE_KEYS[key] && Object.keys(data).some(function (k) { return typeof data[k] === 'string' && HANGUL_RE.test(data[k]); })) {
    let prev = null;
    try { prev = id ? findById_(ent.sheet, ent.idField, id) : null; } catch (e) { prev = null; }
    translated = translateKorean_(key, data, getSettings_(), prev);
  }
  // v0.136.0：同じ保存を2回受けても、2件にしない。画面は電波が切れた時、同じ reqId でもう一度送る
  //   （1回目がサーバーに届いていて、返事だけが届かなかったこともある）。1回目の返事を6時間覚えておき、2回目はそれを返す
  const reqKey = typeof p.reqId === 'string' && /^r[0-9a-z]{6,40}$/.test(p.reqId) ? 'req_' + me.id + '_' + p.reqId : '';
  const res = withLock_(function () {
    if (reqKey) {
      let seen = null;
      try { seen = CacheService.getScriptCache().get(reqKey); } catch (e) { seen = null; }
      if (seen) { try { const again = JSON.parse(seen); again.repeated = true; return again; } catch (e) { /* 読めなければ、ふつうに保存する */ } }
    }
    const out = saveBody_();
    if (reqKey) { try { const txt = JSON.stringify(out); if (txt.length < 90000) CacheService.getScriptCache().put(reqKey, txt, 21600); } catch (e) { /* 覚えられなくても、保存はできている */ } }
    return out;
  });
  function saveBody_() {
    if (key === 'maker') ensureSheet_(ent.sheet);      // v0.142.0：初期設定の前でも、最初の保存でシートを作る
    ensureColumns_(ent.sheet);
    let existing = id ? findById_(ent.sheet, ent.idField, id) : null;
    // 退避した古い対応を直す時は、元のシートに戻してから（v0.112.0）
    if (id && !existing && key === 'activity' && restoreArchivedActivity_(id)) existing = findById_(ent.sheet, ent.idField, id);
    if (id && !existing) throw appError_('notfound', 'その' + ent.label + 'が見つかりません。他の人が消した可能性があります。');
    // 認証情報を見せない設定の時、スタッフは「新しく登録」だけできる（見る・直すは管理者だけ。v0.21.0 で v0.19.0 の動きに戻した）
    if (key === 'credential' && existing && !canSeeSecrets_(me, getSettings_())) {
      throw appError_('forbidden', '認証情報の編集は管理者だけができます。');
    }
    const values = validateEntity_(key, data, existing, me, ctx0);
    const now = nowStamp_();

    if (!existing) {
      const newId = nextId_(ent.sheet, ent.idField, ent.prefix, ent.digits);
      const rec = { '登録日時': now, '更新日時': now };
      rec[ent.idField] = newId;
      Object.keys(values).forEach(function (k) { rec[k] = values[k]; });
      appendRecord_(ent.sheet, rec);
      logAudit_(ent.label + '追加', newId, customerIdOf_(key, rec), '', '', auditText_(rec[ent.nameField]), me.name);
      // 書いた値から返事を作る（表を読み直さない）
      const made = { record: toClient_(key, echoRow_(ent.sheet, null, rec)), created: true };
      return after ? Object.assign(made, after(rec, me)) : made;
    }

    const changes = {};
    const names = [], befores = [], afters = [];
    Object.keys(values).forEach(function (k) {
      if (String(values[k]) === String(existing[k] === undefined ? '' : existing[k])) return;
      // 後から足した「はい／いいえ」の列は、前からある行では空。空→「いいえ」は、変えたことにしない（v0.99.0）
      if (values[k] === NO && (existing[k] === '' || existing[k] === undefined) && ent.fields.some(function (f) { return f.name === k && f.type === 'yesno'; })) return;
      changes[k] = values[k];
      names.push(k);
      const secret = isSecretField_(key, k);
      befores.push(k + ': ' + (secret ? '（非表示）' : existing[k]));
      afters.push(k + ': ' + (secret ? '（非表示）' : values[k]));
    });
    if (names.length) {
      changes['更新日時'] = now;
      updateRecord_(ent.sheet, existing._row, changes);
      if (changes['顧客ID'] !== undefined) movePhotosOf_(key, id, changes['顧客ID']);
      logAudit_(ent.label + '変更', id, customerIdOf_(key, existing), names.join('、'), befores.join(' / '), afters.join(' / '), me.name);
    }
    const saved = { record: toClient_(key, echoRow_(ent.sheet, existing, changes)), created: false };
    return after ? Object.assign(saved, after(Object.assign({}, existing, changes), me)) : saved;
  }
  if (translated.length) res.translated = translated;
  res.srvMs = Date.now() - tStart;      // サーバーで使った時間（画面の下の「読み込み：…」に出す。v0.88.0）
  // 控えの作り直しは、画面がこのあと別に呼ぶ warmAfterSave で（v0.112.0。保存の返事を待たせない）
  if (key !== 'credential') res.warm = ent.sheet;
  return res;
}

/**
 * 保存の後で、そのシートから作る控え（一覧・要対応）を作り直しておく（v0.108.0）。
 *   画面は保存の返事を待たずに先へ進むので、ここで少し時間を使っても待たせない。
 *   次の「更新」や、他の人の読み込みは、シートを読まずに控えから返せる（保存の直後の「更新」が遅かった）。
 */
/**
 * 保存の後で、画面が裏で呼ぶ（v0.112.0）。保存そのものとは別の実行なので、保存の返事は待たない。
 * @param {{token:string, sheets:string[]}} params
 */
function warmAfterSave(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const known = {};
    Object.keys(CACHE_DEPS).forEach(function (k) { CACHE_DEPS[k].forEach(function (n) { known[n] = true; }); });
    const sheets = (Array.isArray(p.sheets) ? p.sheets : []).filter(function (n) { return typeof n === 'string' && known[n]; }).slice(0, 6);
    sheets.forEach(warmAfterSave_);
    return { warmed: sheets };
  });
}
function warmAfterSave_(sheetName) {
  try {
    if (!cacheOn_()) return;
    const parts = Object.keys(CACHE_DEPS).filter(function (p) { return p.indexOf('ref') !== 0 && CACHE_DEPS[p].indexOf(sheetName) !== -1; });
    if (!parts.length || parts.length > 8) return;       // 設定のように、ほとんど全部に効くシートは、作り直さない（読む時に作る）
    bootParts_(parts);
  } catch (e) {
    console.warn('保存の後の控えの作り直しに失敗しました（読む時に作り直します）: ' + e);
  }
}

/** 削除の共通処理（管理者） */
function deleteEntity_(key, params) {
  const p = params || {};
  const me = requireSession_(p.token, true);
  const ent = ENTITIES[key];
  return withLock_(function () {
    let row = findById_(ent.sheet, ent.idField, p.id);
    if (!row && key === 'activity' && restoreArchivedActivity_(p.id)) row = findById_(ent.sheet, ent.idField, p.id);     // 退避した対応も消せる（v0.112.0）
    if (!row) throw appError_('notfound', 'その' + ent.label + 'が見つかりません。');
    const id = String(row[ent.idField]);
    const cleared = [];

    if (key === 'license') {
      const used = readTable_(SHEET_CREDENTIALS).rows.some(function (c) {
        return c['対象区分'] === 'ライセンス' && String(c['対象ID']) === id;
      });
      if (used) throw appError_('invalid', 'このライセンスに紐づく認証情報があります。先に認証情報を消すか、対象を変えてください。');
      // 割当は下の行から消す（上から消すと行番号がずれる）
      readTable_(SHEET_ALLOCATIONS).rows
        .filter(function (a) { return String(a['ライセンスID']) === id; })
        .map(function (a) { return a._row; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (rowNumber) { deleteRecord_(SHEET_ALLOCATIONS, rowNumber); });
    }
    if (key === 'rental') {
      const used = readTable_(SHEET_LOANS).rows.some(function (l) { return String(l['レンタルID']) === id; });
      if (used) throw appError_('invalid', '貸出記録があるレンタル機器は削除できません。使わなくなったら、状態を「廃棄」にしてください。');
    }
    if (key === 'project') {
      // この案件を選んでいた対応・商談は、案件の欄を空にする（記録は残す）
      [[SHEET_ACTIVITIES, '案件ID'], [SHEET_SALESLOGS, '案件ID']].forEach(function (x) {
        readTable_(x[0]).rows.filter(function (r) { return String(r[x[1]]) === id; })
          .forEach(function (r) { updateRecord_(x[0], r._row, { '案件ID': '', '更新日時': nowStamp_() }); });
      });
    }
    if (key === 'repair') {
      readTable_(SHEET_LOANS).rows
        .filter(function (l) { return String(l['修理ID']) === id; })
        .forEach(function (l) { updateRecord_(SHEET_LOANS, l._row, { '修理ID': '', '更新日時': nowStamp_() }); });
    }
    if (key === 'activity') {
      readTable_(SHEET_REPAIRS).rows
        .filter(function (r) { return String(r['元の対応ID']) === id; })
        .forEach(function (r) {
          updateRecord_(SHEET_REPAIRS, r._row, { '元の対応ID': '', '更新日時': nowStamp_() });
          cleared.push(String(r['修理ID']));
        });
    }

    const summary = ent.fields
      .filter(function (f) { return f.type !== 'secret'; })
      .map(function (f) { return f.name + ': ' + row[f.name]; })
      .join(' / ');
    // 付けてあった写真も消す（ドライブのファイルはゴミ箱へ）
    removePhotosOf_(key, id);
    const fresh = findById_(ent.sheet, ent.idField, id);
    deleteRecord_(ent.sheet, fresh._row);
    // 消した Windows情報のピンも外す（同じIDが次の登録で使われても、ピンを引きつがないように。v0.34.0）
    if (key === 'wininfo') {
      const pins = winInfoPins_();
      if (pins.indexOf(id) !== -1) PropertiesService.getScriptProperties().setProperty(WININFO_PIN_PROPERTY, JSON.stringify(pins.filter(function (x) { return x !== id; })));
    }
    logAudit_(ent.label + '削除', id, row['顧客ID'] || '', '', summary, '', me.name);
    return { id: id, clearedRepairIds: cleared };
  });
}

// ---------------------------------------------------------------------------
// 公開関数：登録・編集
//   どれも @param {{token:string, data:Object}} params。data はシートの列名をキーにしたオブジェクト。
//   IDの列（顧客ID・機器ID など）が空なら新規、入っていれば編集。
// ---------------------------------------------------------------------------
function saveCustomer(params) { return api_(function () { return saveEntity_('customer', params); }); }
function saveDevice(params) {
  return api_(function () {
    const p = params || {};
    if (p.data && typeof p.data === 'object') fillOwnWarranty_(p.data, getSettings_());
    return saveEntity_('device', p);
  });
}
/**
 * v0.122.0：購入元が自社（EN・GROW）で、保証期限が空の時は、キッティング日（購入日）から1年（1年後の前日）を入れる。
 *   延長保証などで保証期限を入れた時は、そのまま使う。保証期限を送ってこない更新（一部だけの更新）では何もしない。
 */
function isOwnSource_(v, settings) {
  const s = String(v || '').trim();
  if (!s) return false;
  const norm = function (x) { return String(x || '').replace(/[\s・･.]/g, '').toLowerCase(); };
  const own = norm(settings && settings['自社名']);
  const x = norm(s);
  return s === '自社' || /engrow/.test(x) || (!!own && x.indexOf(own) !== -1);
}
function warrantyFromKitting_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]) + 1, Number(m[2]) - 1, Number(m[3]) - 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function fillOwnWarranty_(data, settings) {
  if (!Object.prototype.hasOwnProperty.call(data, '保証期限') && data['機器ID']) return;
  if (String(data['保証期限'] || '').trim()) return;
  if (!isOwnSource_(data['購入元'], settings)) return;
  const w = warrantyFromKitting_(String(data['購入日'] || '').trim());
  if (w) data['保証期限'] = w;
}
function saveLicense(params) {
  return api_(function () {
    const p = params || {};
    const cred = licenseCredInput_(p.cred);
    // IDとパスワードを入れられる人か、ライセンスを書く前に確かめる（ライセンスだけ保存されて、返事がエラーにならないように）
    if (cred && !canSeeSecrets_(requireSession_(p.token), getSettings_())) throw appError_('forbidden', 'IDとパスワードの登録は管理者だけができます。');
    return saveEntity_('license', p, cred ? function (lic, me) { return saveLicenseCred_(lic, cred, me); } : null);
  });
}
/**
 * v0.117.0：ライセンスをまとめて登録する。キー（シリアルキー）を1行に1つ貼ると、1キー＝1件（数量1）で作り、
 *   キーは認証情報（シリアルキー）に入れる。キーが無ければ、count 件を同じ内容で作る。
 * @param {{token:string, data:Object, keys:Array<string>, count:number}} params
 */
function saveLicenseBulk(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const keys = (Array.isArray(p.keys) ? p.keys : []).map(function (k) { return cleanText_(k).trim(); }).filter(function (k) { return k; });
    const uniq = keys.filter(function (k, i) { return keys.indexOf(k) === i; });
    if (uniq.length > 50) throw appError_('invalid', 'まとめて登録できるのは50件までです。');
    const count = uniq.length || Math.max(0, Math.min(50, parseInt(p.count, 10) || 0));
    if (!count) throw appError_('invalid', 'キーを入れるか、件数を入れてください。');
    if (uniq.length && !canSeeSecrets_(me, getSettings_())) throw appError_('forbidden', 'キー（シリアルキー）の登録は管理者だけができます。');
    const base = p.data && typeof p.data === 'object' ? p.data : {};
    const records = [], creds = [];
    for (let i = 0; i < count; i++) {
      const data = {};
      Object.keys(base).forEach(function (k) { if (k !== 'ライセンスID') data[k] = base[k]; });
      if (uniq.length) data['数量'] = 1;
      const cred = uniq.length ? { loginId: '', password: '', serialKey: uniq[i], clear: false } : null;
      const r = saveEntity_('license', { token: p.token, data: data }, cred ? function (lic, me2) { return saveLicenseCred_(lic, cred, me2); } : null);
      records.push(r.record);
      if (r.cred) creds.push(r.cred);
    }
    logAudit_('ライセンス一括登録', '', String(base['顧客ID'] || ''), '', '', records.length + '件（' + cleanText_(base['製品名']).slice(0, 60) + '）', me.name);
    return { records: records, creds: creds, created: records.length, warm: ENTITIES.license.sheet };
  });
}
function saveActivity(params) { return api_(function () { return saveEntity_('activity', params); }); }
function saveRepair(params) { return api_(function () { return saveEntity_('repair', params); }); }
function saveCredential(params) { return api_(function () { return saveEntity_('credential', params); }); }
function saveMaintenance(params) { return api_(function () { return saveEntity_('maintenance', params); }); }
function saveMemo(params) { return api_(function () { return saveEntity_('memo', params); }); }
function saveNotice(params) { return api_(function () { return saveEntity_('notice', params); }); }
function saveWinInfo(params) { return api_(function () { return saveEntity_('wininfo', params); }); }
function saveRental(params) { return api_(function () { return saveEntity_('rental', params); }); }
function saveLoan(params) { return api_(function () { return saveEntity_('loan', params); }); }
function saveProject(params) { return api_(function () { return saveEntity_('project', params); }); }
function saveSalesLog(params) { return api_(function () { return saveEntity_('saleslog', params); }); }
function saveMaker(params) { return api_(function () { return saveEntity_('maker', params); }); }

// 公開関数：削除（管理者）。@param {{token:string, id:string}} params
function deleteActivity(params) { return api_(function () { return deleteEntity_('activity', params); }); }
function deleteRepair(params) { return api_(function () { return deleteEntity_('repair', params); }); }
function deleteLicense(params) { return api_(function () { return deleteEntity_('license', params); }); }
function deleteCredential(params) { return api_(function () { return deleteEntity_('credential', params); }); }
function deleteMaintenance(params) { return api_(function () { return deleteEntity_('maintenance', params); }); }
function deleteMemo(params) { return api_(function () { return deleteEntity_('memo', params); }); }
function deleteNotice(params) { return api_(function () { return deleteEntity_('notice', params); }); }
function deleteWinInfo(params) { return api_(function () { return deleteEntity_('wininfo', params); }); }
function deleteRental(params) { return api_(function () { return deleteEntity_('rental', params); }); }
function deleteLoan(params) { return api_(function () { return deleteEntity_('loan', params); }); }
function deleteProject(params) { return api_(function () { return deleteEntity_('project', params); }); }
function deleteSalesLog(params) { return api_(function () { return deleteEntity_('saleslog', params); }); }
function deleteMaker(params) { return api_(function () { return deleteEntity_('maker', params); }); }

/**
 * 見込みの案件を、顧客につなげる／受注して開発に入る（v0.82.0。v0.81.0 の convertDeal を案件1本にした）。
 *   to='customer' … まだ顧客でなければ、先方名・連絡先から顧客を作り、案件につなぐ（状態は変えない）
 *   to='order'    … 顧客につないだうえで、状態を「要件確認」にする（営業の段階の案件だけ）
 * @param {{token:string, id:string, to:'customer'|'order'}} params
 * @return {{project:Object, customer:Object, createdCustomer:boolean}}
 */
function convertProject(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const to = cleanText_(p.to);
    if (to !== 'customer' && to !== 'order') throw appError_('invalid', '変換先の指定が正しくありません。');
    const ctx0 = { options: getOptions_(), staffNames: activeStaffNames_() };
    return withLock_(function () {
      const pj = findById_(SHEET_PROJECTS, '案件ID', cleanText_(p.id));
      if (!pj) throw appError_('notfound', 'その案件が見つかりません。他の人が消した可能性があります。');
      if (pj['状態'] === PROJECT_LOST) throw appError_('invalid', '失注の案件は、顧客にできません。先に状態を直してください。');
      if (to === 'order' && PROJECT_SALES.indexOf(pj['状態']) === -1) throw appError_('invalid', 'この案件は、もう受注の後の状態（' + pj['状態'] + '）です。');
      const now = nowStamp_();
      let customer = pj['顧客ID'] ? findById_(SHEET_CUSTOMERS, '顧客ID', pj['顧客ID']) : null;
      let created = false;
      if (!customer) {
        const vals = validateEntity_('customer', {
          '顧客名': pj['先方名'] || pj['案件名'], '電話': pj['電話'], 'メール': pj['メール'], '先方担当者': pj['先方担当者']
        }, null, me, ctx0);
        const cid = nextId_(SHEET_CUSTOMERS, '顧客ID', ENTITIES.customer.prefix, ENTITIES.customer.digits);
        const rec = { '登録日時': now, '更新日時': now };
        rec['顧客ID'] = cid;
        Object.keys(vals).forEach(function (k) { rec[k] = vals[k]; });
        appendRecord_(SHEET_CUSTOMERS, rec);
        logAudit_('顧客追加', cid, cid, '', '', auditText_(rec['顧客名']) + '（案件 ' + pj['案件ID'] + ' から）', me.name);
        customer = findById_(SHEET_CUSTOMERS, '顧客ID', cid);
        created = true;
      }
      const changes = { '顧客ID': String(customer['顧客ID']) };
      if (to === 'order') { changes['状態'] = PROJECT_ORDERED; if (!pj['開始日']) changes['開始日'] = todayYmd_(); }
      changes['更新日時'] = now;
      updateRecord_(SHEET_PROJECTS, pj._row, changes);
      logAudit_('案件変更', String(pj['案件ID']), String(customer['顧客ID']), Object.keys(changes).filter(function (k) { return k !== '更新日時'; }).join('、'),
        auditText_(pj['状態']), auditText_(changes['状態'] || pj['状態']), me.name);
      return {
        project: publicRecord_(Object.assign({}, pj, changes)),
        customer: toClient_('customer', customer),
        createdCustomer: created
      };
    });
  });
}

// ---------------------------------------------------------------------------
// 変更履歴（管理者）
// ---------------------------------------------------------------------------
/**
 * 変更履歴を新しい順に返す。
 * @param {{token:string, limit:number}} params limit は最大500
 */
function getAuditLog(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    const n = parseInt(p.limit, 10);
    const limit = isFinite(n) && n > 0 ? Math.min(n, AUDIT_VIEW_MAX) : 200;
    const tail = readTailRows_(SHEET_AUDIT, limit);       // 変更履歴は長くなるので、最近のぶんだけ読む（v0.97.0）
    return { total: tail.total, logs: tail.rows.slice(-limit).reverse().map(function (r) { return publicRecord_(r); }) };
  });
}

// ---------------------------------------------------------------------------
// ライセンスの割当
// ---------------------------------------------------------------------------
/**
 * ライセンスを機器に割り当てる。
 * @param {{token:string, licenseId:string, deviceId:string}} params
 */
function addAllocation(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const lic = findById_(SHEET_LICENSES, 'ライセンスID', p.licenseId);
      const dev = findById_(SHEET_DEVICES, '機器ID', p.deviceId);
      if (!lic) throw appError_('notfound', 'ライセンスが見つかりません。');
      if (!dev || String(dev['顧客ID']) !== String(lic['顧客ID'])) {
        throw appError_('invalid', '機器は、ライセンスと同じ顧客のものから選んでください。');
      }
      const mine = readTable_(SHEET_ALLOCATIONS).rows.filter(function (a) {
        return String(a['ライセンスID']) === String(lic['ライセンスID']);
      });
      if (mine.some(function (a) { return String(a['機器ID']) === String(dev['機器ID']); })) {
        throw appError_('invalid', 'その機器にはすでに割り当ててあります。');
      }
      if (typeof lic['数量'] === 'number' && lic['数量'] > 0 && mine.length >= lic['数量']) {
        throw appError_('invalid', '数量（' + lic['数量'] + '）を超えるので割り当てられません。');
      }
      const id = nextId_(SHEET_ALLOCATIONS, '割当ID', 'LA', 5);
      appendRecord_(SHEET_ALLOCATIONS, {
        '割当ID': id, 'ライセンスID': lic['ライセンスID'], '機器ID': dev['機器ID'], '割当日': todayYmd_()
      });
      logAudit_('ライセンス割当', lic['ライセンスID'], lic['顧客ID'], '', '', dev['機器ID'], me.name);
      return { allocation: publicRecord_(findById_(SHEET_ALLOCATIONS, '割当ID', id)) };
    });
  });
}

/**
 * 割当を外す。
 * @param {{token:string, allocationId:string}} params
 */
function removeAllocation(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const a = findById_(SHEET_ALLOCATIONS, '割当ID', p.allocationId);
      if (!a) throw appError_('notfound', 'その割当が見つかりません。');
      const lic = findById_(SHEET_LICENSES, 'ライセンスID', a['ライセンスID']);
      deleteRecord_(SHEET_ALLOCATIONS, a._row);
      logAudit_('ライセンス割当解除', a['ライセンスID'], lic ? lic['顧客ID'] : '', '', a['機器ID'], '', me.name);
      return { id: String(a['割当ID']) };
    });
  });
}

// ---------------------------------------------------------------------------
// 認証情報
// ---------------------------------------------------------------------------
/**
 * 顧客の認証情報の一覧（パスワードとシリアルキーは含めない）。
 * @param {{token:string, customerId:string}} params
 */
function listCredentials(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const customerId = cleanText_(p.customerId);
    const rows = readTable_(SHEET_CREDENTIALS).rows.filter(function (r) { return String(r['顧客ID']) === customerId; });
    // 管理者には、パスワードとシリアルキーも最初から渡す（v0.20.0。「表示」を押さなくても見える）。見たことは1行だけ変更履歴に残す
    const withSecrets = me.isAdmin && p.secrets !== false;
    if (withSecrets && p.audit !== false && rows.some(function (r) { return r['パスワード'] || r['シリアルキー']; })) {
      // 変更履歴に書けなくても（他の保存と重なった）、一覧は返す
      try { withLock_(function () { logAudit_('認証情報の表示（一覧）', customerId, customerId, '', '', rows.length + '件', me.name); }); }
      catch (e) { console.warn('認証情報の表示を変更履歴に書けませんでした: ' + e); }
    }
    return {
      credentials: rows.map(function (r) {
        const c = toClient_('credential', r);
        if (withSecrets) { c['パスワード'] = String(r['パスワード'] || ''); c['シリアルキー'] = String(r['シリアルキー'] || ''); }
        return c;
      }),
      canReveal: canSeeSecrets_(me, getSettings_()),
      withSecrets: withSecrets
    };
  });
}

/**
 * 認証情報1件のパスワードとシリアルキーを返す。表示したことは変更履歴に残す。
 * @param {{token:string, id:string}} params
 */
function revealCredential(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    if (!canSeeSecrets_(me, getSettings_())) throw appError_('forbidden', '認証情報の表示は管理者だけができます。');
    return withLock_(function () {
      const row = findById_(SHEET_CREDENTIALS, '認証ID', p.id);
      if (!row) throw appError_('notfound', 'その認証情報が見つかりません。');
      logAudit_('認証情報の表示', row['認証ID'], row['顧客ID'], row['名称'], '', '', me.name);
      return { id: String(row['認証ID']), password: row['パスワード'], serialKey: row['シリアルキー'] };
    });
  });
}

// ---------------------------------------------------------------------------
// 選択肢・設定（管理者）
// ---------------------------------------------------------------------------
/**
 * 選択肢を足す。
 * @param {{token:string, category:string, value:string}} params
 */
function addOption(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const category = cleanText_(p.category);
    const value = cleanText_(p.value).replace(/\n/g, ' ');
    if (OPTION_CATEGORIES.indexOf(category) === -1) throw appError_('invalid', '区分が正しくありません。');
    if (!value) throw appError_('invalid', '値を入れてください。');
    if (value.length > 40) throw appError_('invalid', '値は40文字までです。');
    if (value.indexOf(',') !== -1) throw appError_('invalid', '値に「,」は使えません。');
    return withLock_(function () {
      const rows = readTable_(SHEET_OPTIONS).rows.filter(function (r) { return r['区分'] === category; });
      if ((OPTION_BASE[category] || []).indexOf(value) !== -1 || rows.some(function (r) { return String(r['値']).trim() === value; })) {
        throw appError_('invalid', 'その値はすでにあります。');
      }
      const order = rows.reduce(function (m, r) { return Math.max(m, Number(r['表示順']) || 0); }, 0) + 10;
      appendRecord_(SHEET_OPTIONS, { '区分': category, '値': value, '表示順': order, '有効': YES });
      logAudit_('選択肢追加', category, '', '', '', value, me.name);
      return { options: getOptions_() };
    });
  });
}

/**
 * 選択肢を使う・使わないを切り替える（消さない。過去のデータに残っている値が読めなくなるのを防ぐ）。
 * @param {{token:string, category:string, value:string, active:boolean}} params
 */
function setOptionActive(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    if ((OPTION_BASE[String(p.category)] || []).indexOf(String(p.value)) !== -1) throw appError_('invalid', 'この値は基本の値なので、使わないにはできません。');
    return withLock_(function () {
      const row = readTable_(SHEET_OPTIONS).rows.filter(function (r) {
        return r['区分'] === String(p.category) && String(r['値']).trim() === String(p.value);
      })[0];
      if (!row) throw appError_('notfound', 'その選択肢が見つかりません。');
      const next = p.active ? YES : NO;
      if (row['有効'] !== next) {
        updateRecord_(SHEET_OPTIONS, row._row, { '有効': next });
        logAudit_('選択肢変更', row['区分'], '', row['値'], '有効:' + row['有効'], '有効:' + next, me.name);
      }
      return { options: getOptions_() };
    });
  });
}

/**
 * 設定を保存する。
 * @param {{token:string, values:Object}} params values は {設定のキー: 値}
 */
function saveSettings(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const input = p.values && typeof p.values === 'object' ? p.values : {};
    const clean = {};
    Object.keys(SETTING_TYPES).forEach(function (key) {
      if (input[key] === undefined) return;
      const type = SETTING_TYPES[key];
      let v = cleanText_(input[key]).replace(/\n/g, ' ');
      if (type === 'text') {
        if (v.length > 60) throw appError_('invalid', '「' + key + '」は60文字までです。');
      } else if (type === 'url') {
        if (v && !/^https:\/\/script\.google\.com\/[A-Za-z0-9_\-\/.]+\/exec$/.test(v)) {
          throw appError_('invalid', '「' + key + '」は https://script.google.com/…/exec の形で入れてください。');
        }
      } else if (type === 'siteurl') {
        // v0.141.1：公開サイト（Netlify など）は https のサイトのURL。最後に「/」が無ければ付ける
        if (v && !/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?(\/[A-Za-z0-9_\-.\/~%]*)?$/.test(v)) {
          throw appError_('invalid', '「' + key + '」は https://xxxx.netlify.app/ の形で入れてください。');
        }
        if (v && /^https:\/\/[^/]+$/.test(v)) v += '/';
      } else if (type === 'words') {
        if (v.length > 300) throw appError_('invalid', '「' + key + '」は300文字までです。');
      } else if (type === 'rssurl') {
        const urls = v.split(/[\s,]+/).filter(function (x) { return x; });
        if (urls.length > RSS_EXTRA_MAX) throw appError_('invalid', '「' + key + '」は' + RSS_EXTRA_MAX + 'つまでです。');
        urls.forEach(function (u) { if (!WININFO_LINK.test(u)) throw appError_('invalid', '「' + key + '」は https:// で始まるURLを入れてください。'); });
        v = urls.join(',');
      } else if (type === 'days' || type === 'count' || type === 'day' || type === 'hour') {
        const max = { days: 3650, count: 99999, day: 31, hour: 23 }[type];
        if (!/^\d{1,5}$/.test(v) || Number(v) > max) throw appError_('invalid', '「' + key + '」は0〜' + max + 'の数字で入れてください。');
        if (key === '配信を確かめる間隔（時間）' && (Number(v) < 1 || Number(v) > 6)) throw appError_('invalid', '「' + key + '」は1〜6の数字で入れてください。');
        if (key === '定期保守の1日の上限（社）' && (Number(v) < 1 || Number(v) > 20)) throw appError_('invalid', '「' + key + '」は1〜20の数字で入れてください。');
        if ((key === '定期保守の10台あたりの時間（分）') && (Number(v) < 10 || Number(v) > 480)) throw appError_('invalid', '「' + key + '」は10〜480の数字で入れてください。');
        if ((key === '定期保守の移動時間（分）') && Number(v) > 240) throw appError_('invalid', '「' + key + '」は0〜240の数字で入れてください。');
        v = String(Number(v));
      } else if (type === 'emails') {
        const list = v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
        if (list.length > 5) throw appError_('invalid', '「' + key + '」は5件までです。');
        list.forEach(function (addr) {
          if (addr.length > 120 || !/^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(addr)) {
            throw appError_('invalid', '「' + key + '」のメールアドレスが正しくありません：' + addr.slice(0, 40));
          }
        });
        v = list.join(',');
      } else if (type === 'yesno') {
        if (v !== YES && v !== NO) throw appError_('invalid', '「' + key + '」は「はい」か「いいえ」です。');
      } else if (type === 'calids') {
        // カレンダーIDを、カンマ・空白・改行で区切っていくつでも（10個まで。v0.114.0）
        const ids = v.split(/[,、\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
        if (ids.length > 10) throw appError_('invalid', '「' + key + '」は10個までです。');
        ids.forEach(function (x) { if (!/^[^\s<>"',]{3,200}$/.test(x)) throw appError_('invalid', '「' + key + '」は、カレンダーのID（例：abc123@group.calendar.google.com）を入れてください。'); });
        v = ids.filter(function (x, i) { return ids.indexOf(x) === i; }).join(',');
      } else if (type === 'hm') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(v.replace(/：/g, ':'));
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw appError_('invalid', '「' + key + '」は 9:00 のように入れてください。');
        v = Number(m[1]) + ':' + m[2];
      } else if (type === 'calid') {
        if (v && !/^[^\s<>"']{3,200}$/.test(v)) throw appError_('invalid', '「' + key + '」は、カレンダーのID（例：abc123@group.calendar.google.com）を入れてください。');
      } else if (type === 'cats') {
        const known = ALERT_CATEGORIES.map(function (c) { return c[0]; });
        const picked = v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
        picked.forEach(function (k) { if (known.indexOf(k) === -1) throw appError_('invalid', '「' + key + '」に、知らない種類が入っています。'); });
        v = known.filter(function (k) { return picked.indexOf(k) !== -1; }).join(',');
      } else if (type === 'start') {
        if (START_VIEWS.indexOf(v) === -1) throw appError_('invalid', '「' + key + '」は「' + START_VIEWS.join('」か「') + '」です。');
      }
      clean[key] = v;
    });
    return withLock_(function () {
      const rows = readTable_(SHEET_SETTINGS).rows;
      const current = getSettings_();
      Object.keys(clean).forEach(function (key) {
        if (String(current[key]) === clean[key]) return;
        const row = rows.filter(function (r) { return String(r['キー']).trim() === key; })[0];
        if (row) {
          updateRecord_(SHEET_SETTINGS, row._row, { '値': clean[key] });
        } else {
          const def = SETTING_DEFAULTS.filter(function (d) { return d[0] === key; })[0];
          appendRecord_(SHEET_SETTINGS, { 'キー': key, '値': clean[key], '説明': def ? def[2] : '' });
        }
        logAudit_('設定変更', key, '', key, current[key], clean[key], me.name);
      });
      CacheService.getScriptCache().remove(BRAND_CACHE_KEY);
      CacheService.getScriptCache().remove(TIPS_CACHE_KEY);
      CacheService.getScriptCache().remove(RSS_CACHE_KEY);
      return { settings: publicSettings_(getSettings_()) };
    });
  });
}

function publicSettings_(settings) {
  const out = {};
  Object.keys(SETTING_TYPES).forEach(function (k) { out[k] = settings[k]; });
  return out;
}

// ---------------------------------------------------------------------------
// Windows情報（Windows Update・ドライバーの不具合など）
// ---------------------------------------------------------------------------
function sortWinInfo_(rows) {
  return rows.slice().sort(function (a, b) {
    return compareDesc_(String(a['日付']), String(b['日付'])) || compareDesc_(String(a['情報ID']), String(b['情報ID']));
  });
}

/** ピン留めした Windows情報のID（新しくピン留めしたものが先。v0.33.0） */
function winInfoPins_() {
  let a = null;
  try { a = JSON.parse(PropertiesService.getScriptProperties().getProperty(WININFO_PIN_PROPERTY) || '[]'); } catch (e) { a = null; }
  return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(x); }).slice(0, WININFO_PIN_MAX) : [];
}

/** 一番上に出すぶん。ピン留めしたものを先に（日付が古くても出す）、残りは日付が新しいものから */
function recentWinInfo_(rows, today, forCustomer) {
  const p = today.split('-');
  const from = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - WININFO_SHOW_DAYS), scriptTz_(), 'yyyy-MM-dd');
  const ok = function (r) { return !forCustomer || r['顧客に見せる'] === YES; };
  const pins = winInfoPins_();
  const pinned = [];
  pins.forEach(function (id) { const r = rows.find(function (x) { return String(x['情報ID']) === id; }); if (r && ok(r)) pinned.push(r); });
  const rest = sortWinInfo_(rows.filter(function (r) {
    return pins.indexOf(String(r['情報ID'])) === -1 && r['日付'] >= from && r['日付'] <= today && ok(r);
  })).slice(0, WININFO_SHOW_MAX);
  return pinned.concat(rest);
}

/**
 * 古い Windows情報を消す（毎朝の処理から。v0.34.0）
 *   設定「Windows情報を残す日数」より日付が古いものを消す。ピン留めしたものは残す。0 なら何もしない。
 * @return {number} 消した件数
 */
function tidyWinInfo_() {
  // 読めない値（文字・マイナス）の時は消さない。大きすぎる値は上限（100年）にする
  const n = parseInt(getSettings_()['Windows情報を残す日数'], 10);
  if (!isFinite(n) || n <= 0) return 0;
  const days = Math.min(n, 36500);
  const today = todayYmd_(), p = today.split('-');
  const before = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - days), scriptTz_(), 'yyyy-MM-dd');
  return withLock_(function () {
    const pins = winInfoPins_();
    const old = readTable_(SHEET_WININFO).rows.filter(function (r) {
      const d = String(r['日付'] || '');
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < before && pins.indexOf(String(r['情報ID'])) === -1;
    }).sort(function (a, b) { return b._row - a._row; }).slice(0, WININFO_TIDY_MAX);
    old.forEach(function (r) { deleteRecord_(SHEET_WININFO, r._row); });     // 下の行から消す（行番号がずれないように）
    if (old.length) logAudit_('古いWindows情報を片づけ', old.length + '件', '', '', '', before + ' より前', '自動更新');
    return old.length;
  });
}

/**
 * Windows情報をピン留めする・外す（v0.33.0）。ピン留めしたものは、期限（日数）にかかわらず、一番上に出しつづける。
 * @param {{token:string, id:string, pin:boolean}} params
 */
function pinWinInfo(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const id = String(p.id || '');
      const row = findById_(SHEET_WININFO, '情報ID', id);
      if (!row) throw appError_('notfound', 'Windows情報が見つかりません。');
      const all = readTable_(SHEET_WININFO).rows.map(function (r) { return String(r['情報ID']); });
      let pins = winInfoPins_().filter(function (x) { return x !== id && all.indexOf(x) !== -1; });   // 消したものは片づける
      if (p.pin === true) {
        if (pins.length >= WININFO_PIN_MAX) throw appError_('invalid', 'ピン留めは' + WININFO_PIN_MAX + '件までです。いらないものを外してください。');
        pins.unshift(id);
      }
      PropertiesService.getScriptProperties().setProperty(WININFO_PIN_PROPERTY, JSON.stringify(pins));
      logAudit_(p.pin === true ? 'Windows情報をピン留め' : 'Windows情報のピンを外す', id, '', '', '', String(row['タイトル'] || ''), me.name);
      return { pins: pins };
    });
  });
}

/**
 * Windows情報を、貼り付けた文からまとめて登録する。1行に1件。
 *   日付｜種類｜重要度｜タイトル｜内容｜リンク　（区切りは「｜」か「|」。内容とリンクは省ける）
 * 同じ日付・同じタイトルのものが既にあれば、その行は飛ばす。
 * @param {{token:string, text:string}} params
 */
function importWinInfo(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const text = typeof p.text === 'string' ? p.text : '';
    if (text.length > 30000) throw appError_('invalid', '貼り付けた文が長すぎます。');
    const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l.charAt(0) !== '#'; });
    if (!lines.length) throw appError_('invalid', '登録する行がありません。');
    if (lines.length > WININFO_IMPORT_MAX) throw appError_('invalid', '一度に登録できるのは' + WININFO_IMPORT_MAX + '行までです。');
    return withLock_(function () {
      // 1行ずつ、項目に分ける（形が違う行は null にして、行番号つきで知らせる）
      const items = lines.map(function (line) {
        const c = line.split(/\s*[｜|]\s*/);
        const f = String(c[0]).toUpperCase() === 'INFO' ? c.slice(1) : c;       // 配信ファイルと同じ「INFO｜…」の形でもよい
        if (f.length < 4) return null;
        return { '日付': f[0], '種類': WININFO_KINDS.indexOf(f[1]) !== -1 ? f[1] : 'その他', '重要度': NOTICE_LEVELS.indexOf(f[2]) !== -1 ? f[2] : '通常',
          'タイトル': f[3], '内容': f[4] || '', 'リンク': f[5] || '' };
      });
      const r = addWinInfoRows_(items, YES, me);
      if (r.added) logAudit_('Windows情報をまとめて登録', r.firstId + '〜' + r.lastId, '', '', '', r.added + '件', me.name);
      return { added: r.added, skipped: r.skipped, errors: r.errors, wininfo: sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (x) { return publicRecord_(x); }) };
    });
  });
}

// ---------------------------------------------------------------------------
// お客様ビューのURL（管理者）
// ---------------------------------------------------------------------------
/** ウェブアプリのURL（.../exec）。設定に入れてあればそれを使う */
function webAppUrl_() {
  return getSettings_()['ウェブアプリURL'] || ScriptApp.getService().getUrl() || '';
}

/** v0.141.0：人が開くURL（Netlify などに埋め込んで公開している時は、そのサイト）。収集ツールの送り先は webAppUrl_ のまま */
function siteUrl_() {
  return getSettings_()['公開サイトのURL'] || webAppUrl_();
}
/** 埋め込んでよいサイトの origin（https://xxxx.netlify.app）。設定が無ければ空 */
function siteOrigin_() {
  const m = /^(https:\/\/[^/?#]+)/i.exec(String(getSettings_()['公開サイトのURL'] || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function portalUrl_(portalToken) {
  if (!portalToken) return '';
  const base = siteUrl_();
  return base ? base + (base.indexOf('?') === -1 ? '?' : '&') + 't=' + portalToken : '';
}

/**
 * お客様ビューのURLを発行する。発行し直すと、前のURLは使えなくなる。
 * @param {{token:string, customerId:string}} params
 */
function issuePortalToken(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!c) throw appError_('notfound', '顧客が見つかりません。');
      const portalToken = newToken_();
      const had = !!c['ポータルトークン'];
      updateRecord_(SHEET_CUSTOMERS, c._row, { 'ポータルトークン': portalToken, '更新日時': nowStamp_() });
      logAudit_(had ? 'お客様ビューURL再発行' : 'お客様ビューURL発行', c['顧客ID'], c['顧客ID'], '', '', '', me.name);
      const url = portalUrl_(portalToken);
      return { url: url, needsUrlSetting: !url, record: toClient_('customer', findById_(SHEET_CUSTOMERS, '顧客ID', c['顧客ID'])) };
    });
  });
}

/**
 * 発行済みのお客様ビューのURLを返す。
 * @param {{token:string, customerId:string}} params
 */
function getPortalUrl(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
    if (!c) throw appError_('notfound', '顧客が見つかりません。');
    const url = portalUrl_(c['ポータルトークン']);
    return { url: url, issued: !!c['ポータルトークン'], needsUrlSetting: !!c['ポータルトークン'] && !url };
  });
}

// ---------------------------------------------------------------------------
// ライセンスの ID・パスワード・シリアルキー（v0.15.0）
//   ライセンスの入力の窓から入れる。入れ先は「認証情報」シート（対象区分＝ライセンス、対象ID＝ライセンスID）。
//   ライセンスのシートの列は変えない。パスワード・シリアルキーは、空のまま送ると「今のまま」。
// ---------------------------------------------------------------------------
/** 画面から来た cred を検査する。送られていなければ null（ライセンスだけ保存する） */
function licenseCredInput_(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw appError_('invalid', 'IDとパスワードの形式が正しくありません。');
  const f = {};
  ENTITIES.credential.fields.forEach(function (x) { f[x.name] = x; });
  const one = function (name, key) {
    const v = raw[key];
    if (v !== undefined && v !== null && typeof v !== 'string') throw appError_('invalid', '「' + name + '」の形式が正しくありません。');
    return normalizeField_(f[name], v || '', '', {});
  };
  return { loginId: one('ログインID', 'loginId'), password: one('パスワード', 'password'), serialKey: one('シリアルキー', 'serialKey'), clear: raw.clear === true };
}

/** ライセンスに紐づく認証情報（一番上の1件）。withLock_ の中で呼ぶ */
function licenseCredRow_(licenseId) {
  return readTable_(SHEET_CREDENTIALS).rows.filter(function (c) {
    return c['対象区分'] === 'ライセンス' && String(c['対象ID']) === String(licenseId);
  })[0] || null;
}

/** ライセンスを保存した直後に、IDとパスワードを認証情報に入れる。withLock_ の中で呼ばれる */
function saveLicenseCred_(lic, cred, me) {
  const licenseId = String(lic['ライセンスID']);
  const row = licenseCredRow_(licenseId);
  const now = nowStamp_();
  if (!row) {
    if (!cred.loginId && !cred.password && !cred.serialKey) return { cred: null };
    const id = nextId_(SHEET_CREDENTIALS, '認証ID', ENTITIES.credential.prefix, ENTITIES.credential.digits);
    const rec = {
      '認証ID': id, '顧客ID': String(lic['顧客ID']), '対象区分': 'ライセンス', '対象ID': licenseId,
      '名称': cleanText_(lic['製品名']).slice(0, 100) || 'ライセンス', 'ログインID': cred.loginId, 'パスワード': cred.password,
      'シリアルキー': cred.serialKey, '備考': '', '登録日時': now, '更新日時': now
    };
    appendRecord_(SHEET_CREDENTIALS, rec);
    logAudit_('認証情報追加', id, rec['顧客ID'], '', '', rec['名称'] + '（ライセンスの窓から）', me.name);
    return { cred: toClient_('credential', echoRow_(SHEET_CREDENTIALS, null, rec)) };
  }
  const changes = {};
  const names = [];
  if (cred.loginId !== String(row['ログインID'] || '')) { changes['ログインID'] = cred.loginId; names.push('ログインID'); }
  // パスワード・シリアルキーは、入れた時だけ変える。「消す」を選んだ時は空にする
  if (cred.password || cred.clear) { if (cred.password !== String(row['パスワード'] || '')) { changes['パスワード'] = cred.password; names.push('パスワード'); } }
  if (cred.serialKey || cred.clear) { if (cred.serialKey !== String(row['シリアルキー'] || '')) { changes['シリアルキー'] = cred.serialKey; names.push('シリアルキー'); } }
  if (names.length) {
    changes['更新日時'] = now;
    updateRecord_(SHEET_CREDENTIALS, row._row, changes);
    logAudit_('認証情報変更', String(row['認証ID']), String(row['顧客ID']), names.join('、'), '', '（ライセンスの窓から）', me.name);
  }
  return { cred: toClient_('credential', echoRow_(SHEET_CREDENTIALS, row, changes)) };
}

// ---------------------------------------------------------------------------
// 機器を別の顧客へ移す（管理者・v0.15.0）
//   キッティングで「自社キッティング」の顧客に受けた機器を、納品先の顧客へ移すときなどに使う。
//   一緒に移すもの … 機器の写真・その機器の認証情報・その機器を選んである対応履歴／修理／保守（と、その写真）。
//   外すもの     … ライセンスの割当（前の顧客のライセンスなので）。
//   機器診断は機器IDで持っているので、そのまま付いていく。
// ---------------------------------------------------------------------------
/** @param {{token:string, deviceId:string, customerId:string}} params */
function moveDevice(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const res = withLock_(function () {
      const dev = findById_(SHEET_DEVICES, '機器ID', p.deviceId);
      if (!dev) throw appError_('notfound', 'その機器が見つかりません。');
      const to = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!to) throw appError_('invalid', '移す先の顧客が見つかりません。');
      const deviceId = String(dev['機器ID']);
      const from = String(dev['顧客ID']);
      const toId = String(to['顧客ID']);
      if (from === toId) throw appError_('invalid', '今と同じ顧客です。');
      const now = nowStamp_();
      const moved = { activities: [], repairs: [], maintenances: [], credentials: [], allocations: 0 };

      updateRecord_(SHEET_DEVICES, dev._row, { '顧客ID': toId, '更新日時': now });
      // v0.106.0：行ごとに書かず、シートごとに1回で書く（記録や添付が多い機器でも、待たせない）
      const photoPairs = [['device', deviceId]];

      // v0.126.0：表を丸ごと読まず、この機器IDの行だけ探す（rowsWhere_）
      const credRows = [];
      rowsWhere_(SHEET_CREDENTIALS, '対象ID', deviceId)
        .filter(function (c) { return c['対象区分'] === '機器'; })
        .forEach(function (c) { credRows.push(c._row); moved.credentials.push(String(c['認証ID'])); });
      updateRowsSame_(SHEET_CREDENTIALS, credRows, { '顧客ID': toId, '更新日時': now });

      const actCust = {};
      [['activity', SHEET_ACTIVITIES, '対応ID', 'activities'], ['repair', SHEET_REPAIRS, '修理ID', 'repairs'], ['maintenance', SHEET_MAINT, '実施ID', 'maintenances']]
        .forEach(function (t) {
          const rowsToMove = [];
          rowsWhere_(t[1], '機器ID', deviceId).forEach(function (r) {
            const mine = String(r['顧客ID']) !== toId;
            if (t[0] === 'activity') actCust[String(r['対応ID'])] = mine ? toId : String(r['顧客ID']);   // 動かした後の顧客（後で読み直さない）
            if (!mine) return;
            rowsToMove.push(r._row);
            photoPairs.push([t[0], String(r[t[2]])]);
            moved[t[3]].push(String(r[t[2]]));
          });
          updateRowsSame_(t[1], rowsToMove, { '顧客ID': toId, '更新日時': now });
        });
      movePhotosMany_(photoPairs, toId);

      // 修理の「元の対応ID」が、別の顧客の対応を指したままにならないようにする（今回動かしたものに関係する修理だけ）
      const movedActs = {}, movedReps = {};
      moved.activities.forEach(function (x) { movedActs[x] = true; });
      moved.repairs.forEach(function (x) { movedReps[x] = true; });
      const clearedRepairs = [], clearRows = [];
      // v0.126.0：動かした対応・修理が無ければ、修理・貸出の表は読まない（仮受付のPCなど、ほとんどの場合）
      const anyMoved = moved.activities.length || moved.repairs.length;
      (anyMoved ? readTable_(SHEET_REPAIRS).rows : []).forEach(function (r) {
        const src = String(r['元の対応ID'] || '');
        if (!src || !(movedReps[String(r['修理ID'])] || movedActs[src])) return;
        // この機器の対応でなければ、その対応の顧客を調べる（v0.126.0：対応の表を丸ごと読まなくなったため）
        if (actCust[src] === undefined) { const a = findById_(SHEET_ACTIVITIES, '対応ID', src); actCust[src] = a ? String(a['顧客ID']) : undefined; }
        if (actCust[src] !== undefined && actCust[src] !== String(r['顧客ID'])) { clearRows.push(r._row); clearedRepairs.push(String(r['修理ID'])); }
      });
      updateRowsSame_(SHEET_REPAIRS, clearRows, { '元の対応ID': '', '更新日時': now });
      // 前の顧客の貸出記録が、移した修理を指したままにならないようにする
      const clearedLoans = [], loanRows = [];
      (moved.repairs.length ? readTable_(SHEET_LOANS).rows : []).forEach(function (l) {
        if (movedReps[String(l['修理ID'] || '')] && l['顧客ID'] && String(l['顧客ID']) !== toId) { loanRows.push(l._row); clearedLoans.push(String(l['貸出ID'])); }
      });
      updateRowsSame_(SHEET_LOANS, loanRows, { '修理ID': '', '更新日時': now });

      // ライセンスの割当は外す（下の行から消す）
      const allocList = rowsWhere_(SHEET_ALLOCATIONS, '機器ID', deviceId);
      const allocRows = allocList
        .map(function (a) { return a._row; })
        .sort(function (a, b) { return b - a; });
      const allocIds = allocList.map(function (a) { return String(a['割当ID']); });
      allocRows.forEach(function (rowNumber) { deleteRecord_(SHEET_ALLOCATIONS, rowNumber); });
      moved.allocations = allocRows.length;

      const summary = [custLabel_(from) + ' → ' + custLabel_(toId),
        '対応' + moved.activities.length + '・修理' + moved.repairs.length + '・保守' + moved.maintenances.length + '・認証情報' + moved.credentials.length + '件を一緒に移した',
        moved.allocations ? 'ライセンスの割当' + moved.allocations + '件を外した' : ''].filter(function (x) { return x; }).join(' / ');
      logAudit_('機器の顧客を移動', deviceId, toId, '顧客ID', from, summary, me.name);
      if (from) logAudit_('機器の顧客を移動', deviceId, from, '顧客ID', from, summary, me.name);
      // 書いた値から返事を作る（読み直さない。v0.126.0）
      return { record: toClient_('device', echoRow_(SHEET_DEVICES, dev, { '顧客ID': toId, '更新日時': now })), moved: moved, clearedRepairIds: clearedRepairs, clearedLoanIds: clearedLoans, allocIds: allocIds };
    });
    // v0.126.0：他の項目も変えていたら、同じ実行で続けて保存する（前は画面がもう1回サーバーを呼んでいて、待ちが2回分だった）
    if (p.data && typeof p.data === 'object') {
      const data = Object.assign({}, p.data, { '機器ID': String(p.deviceId), '顧客ID': String(p.customerId) });
      fillOwnWarranty_(data, getSettings_());
      const saved = saveEntity_('device', { token: p.token, data: data });
      res.record = saved.record;
    }
    res.warm = SHEET_DEVICES;
    return res;
  });
}

// ---------------------------------------------------------------------------
// 仮受付の機器を削除する（管理者・v0.64.0）
//   収集ツールがトークンなしで送ってきて「仮受付（未割り当て）」に入った機器だけ、消せる。
//   他の顧客の機器は消せない（消すのではなく、廃棄にする）。
//   対応・修理・保守・認証情報・ライセンスの割当がもう付いている機器は、消さない（先に顧客を選び直して振り分ける）。
//   機器診断（収集ツールの情報）と写真は、機器と一緒に消す。
// ---------------------------------------------------------------------------
/** @param {{token:string, id:string}} params */
function deleteDevice(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const dev = findById_(SHEET_DEVICES, '機器ID', p.id);
      if (!dev) throw appError_('notfound', 'その機器が見つかりません。');
      const pend = readTable_(SHEET_CUSTOMERS).rows.filter(function (c) { return c['顧客名'] === PENDING_CUSTOMER_NAME; })[0];
      if (!pend || String(dev['顧客ID']) !== String(pend['顧客ID'])) {
        throw appError_('invalid', '消せるのは、「' + PENDING_CUSTOMER_NAME + '」に入っている機器だけです。使わなくなった機器は、状況を「廃棄」にしてください。');
      }
      const id = String(dev['機器ID']);
      const used = [[SHEET_ACTIVITIES, '対応'], [SHEET_REPAIRS, '修理'], [SHEET_MAINT, '保守'], [SHEET_ALLOCATIONS, 'ライセンスの割当']].filter(function (t) {
        return readTable_(t[0]).rows.some(function (r) { return String(r['機器ID']) === id; });
      }).map(function (t) { return t[1]; });
      if (readTable_(SHEET_CREDENTIALS).rows.some(function (c) { return c['対象区分'] === '機器' && String(c['対象ID']) === id; })) used.push('認証情報');
      if (used.length) throw appError_('invalid', 'この機器には「' + used.join('・') + '」の記録が付いているので、消せません。先に顧客を選び直して振り分けてください。');
      // 収集ツールの情報（機器診断）は下の行から消す
      readTable_(SHEET_DIAGNOSTICS).rows
        .filter(function (g) { return String(g['機器ID']) === id; })
        .map(function (g) { return g._row; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (rowNumber) { deleteRecord_(SHEET_DIAGNOSTICS, rowNumber); });
      removePhotosOf_('device', id);
      const summary = ['シリアル: ' + dev['シリアル'], '機種名: ' + dev['機種名'], '利用者: ' + dev['利用者']].join(' / ');
      deleteRecord_(SHEET_DEVICES, findById_(SHEET_DEVICES, '機器ID', id)._row);
      logAudit_('機器削除（仮受付）', id, String(pend['顧客ID']), '', summary, '', me.name);
      return { id: id, clearedRepairIds: [] };
    });
  });
}

function custLabel_(customerId) {
  const c = customerId ? findById_(SHEET_CUSTOMERS, '顧客ID', customerId) : null;
  return c ? String(c['顧客名']) + '（' + customerId + '）' : String(customerId || '（なし）');
}

// =============================================================================
// ここから：元 Files.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Files.gs … 添付ファイルとレイアウト図
 *
 * ファイルの実体は、デプロイした人の Google ドライブの「PC管理パッケージのファイル」フォルダーに置く。
 *   - 添付：設定「添付をリンクで共有する」が「はい」なら、リンクを知っている人が見られる状態にする
 *           （スタッフがスマホから開けるように。URLはログインしたスタッフと、公開を選んだお客様ページにだけ渡す）
 *   - レイアウト図の背景画像：共有しない。画面には、このスクリプトが読み出して渡す
 *
 * 公開関数：listAttachments / uploadAttachment / setAttachmentVisible / deleteAttachment
 *           listPhotos / uploadPhoto / getPhoto（記録に付ける写真）、saveLogo（会社のロゴ）
 *           listLayouts / getLayout / createLayout / renameLayout / deleteLayout / saveLayout / saveLayoutImage / removeLayoutImage
 */

// ---------------------------------------------------------------------------
// ドライブ
// ---------------------------------------------------------------------------
function filesFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(FILES_FOLDER_PROPERTY);
  if (id) {
    try {
      const found = DriveApp.getFolderById(id);
      if (!found.isTrashed()) return found;
    } catch (e) { /* 消されていたら作り直す */ }
  }
  const folder = DriveApp.createFolder(FILES_FOLDER_NAME);
  props.setProperty(FILES_FOLDER_PROPERTY, folder.getId());
  return folder;
}

/** 画面から来たBase64を検査してバイト列にする */
function decodeUpload_(base64, maxBytes) {
  const tooBig = function () { return appError_('invalid', 'ファイルが大きすぎます。' + Math.floor(maxBytes / 1024 / 1024) + 'MBまでにしてください。'); };
  if (typeof base64 !== 'string' || !base64) throw appError_('invalid', 'ファイルの中身がありません。');
  if (base64.length > Math.ceil(maxBytes / 3) * 4 + 8) throw tooBig();
  if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(base64)) throw appError_('invalid', 'ファイルの形式が正しくありません。');
  let bytes;
  try { bytes = Utilities.base64Decode(base64); } catch (e) { throw appError_('invalid', 'ファイルの形式が正しくありません。'); }
  if (!bytes.length) throw appError_('invalid', 'ファイルの中身がありません。');
  if (bytes.length > maxBytes) throw tooBig();
  return bytes;
}

/** 先頭のバイトが、その種類のファイルらしいか（拡張子だけ変えたものを弾く） */
function looksLike_(bytes, ext) {
  const at = function (i) { return bytes[i] < 0 ? bytes[i] + 256 : bytes[i]; };
  const starts = function (list) { return list.every(function (b, i) { return at(i) === b; }); };
  if (ext === 'pdf') return starts([0x25, 0x50, 0x44, 0x46]);
  if (ext === 'png') return starts([0x89, 0x50, 0x4E, 0x47]);
  if (ext === 'jpg' || ext === 'jpeg') return starts([0xFF, 0xD8]);
  if (ext === 'gif') return starts([0x47, 0x49, 0x46, 0x38]);
  if (ext === 'webp') return starts([0x52, 0x49, 0x46, 0x46]) && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50;
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'zip') return starts([0x50, 0x4B]);
  if (ext === 'doc' || ext === 'xls' || ext === 'ppt') return starts([0xD0, 0xCF, 0x11, 0xE0]);
  return true; // txt・csv は決まった先頭が無い
}

function imageExt_(mimeType) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  // 決めた種類だけ（'constructor' のような、どのオブジェクトにもある名前を通さない）
  return typeof mimeType === 'string' && Object.prototype.hasOwnProperty.call(map, mimeType) ? map[mimeType] : '';
}

function trashFile_(fileId) {
  if (!fileId) return;
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* もう無ければそれでよい */ }
}

// ---------------------------------------------------------------------------
// 添付
// ---------------------------------------------------------------------------
/** 記録の写真を、その人が付けたか（スタッフIDで見分ける。IDの無い前からの行だけ、表示名で見分ける。v0.20.0） */
function ownPhoto_(row, me) {
  if (!row || !row['対象区分'] || !me) return false;
  const by = String(row['登録者ID'] || '');
  return by ? by === String(me.id) : String(row['登録者'] || '') === String(me.name);
}

function attachmentForClient_(row, me) {
  return {
    '自分のもの': ownPhoto_(row, me),
    '添付ID': row['添付ID'], '顧客ID': row['顧客ID'], 'ファイル名': row['ファイル名'], 'サイズ': row['サイズ'], '種類': row['種類'],
    'お客様に見せる': row['お客様に見せる'], '登録者': row['登録者'], '登録日時': row['登録日時'],
    '対象区分': row['対象区分'] || '', '対象ID': row['対象ID'] || '',
    url: 'https://drive.google.com/file/d/' + row['DriveファイルID'] + '/view'
  };
}

/** data URL（画像）を検査する。形・長さ・中身の先頭が合っていれば、そのまま返す。だめなら '' */
function cleanImageDataUrl_(v, maxChars) {
  if (typeof v !== 'string' || !v || v.length > maxChars) return '';
  const m = DATA_URL_IMAGE.exec(v);
  if (!m) return '';
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { return ''; }
  if (!bytes.length || !looksLike_(bytes, m[1] === 'jpeg' ? 'jpg' : m[1])) return '';
  return v;
}

/** 顧客の添付の一覧。@param {{token:string, customerId:string}} params */
function listAttachments(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const customerId = cleanText_(p.customerId);
    const rows = attachRows_().filter(function (r) { return String(r['顧客ID']) === customerId; });
    return { attachments: rows.map(function (r) { return attachmentForClient_(r, me); }).reverse(), shared: getSettings_()['添付をリンクで共有する'] !== NO };
  });
}

/**
 * 添付を足す。
 * @param {{token:string, customerId:string, name:string, mimeType:string, base64:string, visible:boolean}} params
 */
function uploadAttachment(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const name = cleanText_(p.name).replace(/[\n\\\/:*?"<>|]/g, '_').slice(0, 120);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const allowed = Object.prototype.hasOwnProperty.call(ATTACH_TYPES, ext) ? ATTACH_TYPES[ext] : null;
    if (!name || !allowed) {
      throw appError_('invalid', 'この種類のファイルは添付できません。使えるのは ' + Object.keys(ATTACH_TYPES).join('・') + ' です。');
    }
    const given = String(p.mimeType || '').toLowerCase();
    const mimeType = allowed.indexOf(given) !== -1 ? given : allowed[0];
    const bytes = decodeUpload_(p.base64, ATTACH_MAX_BYTES);
    if (!looksLike_(bytes, ext)) throw appError_('invalid', 'ファイルの中身が、拡張子（.' + ext + '）と合っていません。');

    return withLock_(function () {
      const customer = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!customer) throw appError_('invalid', '顧客が見つかりません。');
      const count = attachRows_().filter(function (r) { return String(r['顧客ID']) === String(customer['顧客ID']); }).length;
      if (count >= 200) throw appError_('invalid', '1つの顧客に添付できるのは200件までです。');
      const shared = getSettings_()['添付をリンクで共有する'] !== NO;
      const file = filesFolder_().createFile(Utilities.newBlob(bytes, mimeType, customer['顧客ID'] + '_' + name));
      if (shared) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const id = nextId_(SHEET_ATTACH, '添付ID', 'F', 5);
      appendRecord_(SHEET_ATTACH, {
        '添付ID': id, '顧客ID': customer['顧客ID'], 'ファイル名': name, 'DriveファイルID': file.getId(), 'サイズ': bytes.length, '種類': mimeType,
        'お客様に見せる': p.visible === true && shared ? YES : NO, '登録者': me.name, '登録日時': nowStamp_(), '登録者ID': me.id
      });
      logAudit_('添付追加', id, customer['顧客ID'], '', '', name, me.name);
      return { attachment: attachmentForClient_(attachById_(id), me) };
    });
  });
}

/**
 * 添付をお客様ページに出す・出さないを切り替える。
 * @param {{token:string, id:string, visible:boolean}} params
 */
function setAttachmentVisible(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const row = attachById_(p.id);
      if (!row) throw appError_('notfound', 'その添付が見つかりません。');
      if (p.visible === true && row['対象区分'] === REPORT_TARGET_LABEL) throw appError_('invalid', '収集ツールのレポートは、お客様ページには出せません。');
      if (p.visible === true && getSettings_()['添付をリンクで共有する'] === NO) {
        throw appError_('invalid', '設定「添付をリンクで共有する」が「いいえ」なので、お客様ページには出せません。');
      }
      const next = p.visible === true ? YES : NO;
      if (row['お客様に見せる'] !== next) {
        updateRecord_(SHEET_ATTACH, row._row, { 'お客様に見せる': next });
        logAudit_('添付変更', row['添付ID'], row['顧客ID'], 'お客様に見せる', row['お客様に見せる'], next, me.name);
      }
      return { attachment: attachmentForClient_(attachById_(row['添付ID']), me) };
    });
  });
}

/** 添付を消す（管理者）。ドライブのファイルはゴミ箱に入る。@param {{token:string, id:string}} params */
function deleteAttachment(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const row = attachById_(p.id);
      // 消せるのは管理者。記録に付けた写真だけは、付けた本人も消せる（撮り間違いを直せるように）
      const ownPhoto = ownPhoto_(row, me);
      if (!me.isAdmin && !ownPhoto) throw appError_('forbidden', 'この操作は管理者だけができます。');
      if (!row) throw appError_('notfound', 'その添付が見つかりません。');
      trashFile_(row['DriveファイルID']);
      deleteRecord_(SHEET_ATTACH, row._row);
      logAudit_('添付削除', row['添付ID'], row['顧客ID'], '', row['ファイル名'], '', me.name);
      return { id: String(row['添付ID']) };
    });
  });
}

// ---------------------------------------------------------------------------
// 記録に付ける写真（対応・修理・機器）。添付シートに、対象区分・対象ID・サムネイル付きで入れる
// ---------------------------------------------------------------------------
function photoTarget_(target, targetId) {
  const key = String(target || '');
  const def = Object.prototype.hasOwnProperty.call(PHOTO_TARGETS, key) ? PHOTO_TARGETS[key] : null;
  if (!def) throw appError_('invalid', '添付できるのは、対応・修理・機器・ライセンス・保守・社内メモ・案件・営業です。');
  const row = findById_(def[0], def[1], targetId);
  if (!row) throw appError_('notfound', '写真を付ける記録が見つかりません。');
  return { label: def[2], id: String(row[def[1]]), customerId: String(row['顧客ID'] || '') };
}

/** 添付の行（サムネイルの列は読まない。写真が増えても、一覧や削除が重くならないように） */
function attachRows_() {
  return readTable_(SHEET_ATTACH, ['サムネイル']).rows;
}

function attachById_(id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  return attachRows_().filter(function (r) { return String(r['添付ID']) === want; })[0] || null;
}

function photoRows_(label, id) {
  return attachRows_().filter(function (r) { return r['対象区分'] === label && String(r['対象ID']) === id; });
}

/** 記録ごとの写真の枚数 {'対応:A000001': 2, …}。一覧に「写真あり」の印を出すのに使う */
function photoCounts_() {
  const out = {};
  attachRows_().forEach(function (r) {
    if (!r['対象区分'] || !r['対象ID']) return;
    const k = r['対象区分'] + ':' + r['対象ID'];
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

/** 写真の行に、サムネイルを足す（その写真がある行だけを読む。続いている行は、1回でまとめて読む） */
function withThumbs_(rows) {
  if (!rows.length) return rows;
  const t = tableHead_(SHEET_ATTACH);
  const col = t.headers.indexOf('サムネイル');
  if (col === -1) return rows;
  const nums = rows.map(function (r) { return r._row; }).sort(function (a, b) { return a - b; });
  const thumbs = {};
  let i = 0;
  while (i < nums.length) {
    let k = i;
    while (k + 1 < nums.length && nums[k + 1] === nums[k] + 1) k++;
    const values = t.sheet.getRange(nums[i], col + 1, k - i + 1, 1).getValues();
    for (let n = i; n <= k; n++) thumbs[nums[n]] = String(values[n - i][0] || '');
    i = k + 1;
  }
  return rows.map(function (r) {
    const out = Object.assign({}, r);
    out['サムネイル'] = thumbs[r._row] || '';
    return out;
  });
}

function photoForClient_(row, me) {
  const out = attachmentForClient_(row, me);
  out.thumb = cleanImageDataUrl_(row['サムネイル'], PHOTO_THUMB_MAX_CHARS);
  return out;
}

/** その記録に付いている写真（サムネイル付き）。@param {{token:string, target:string, targetId:string}} params */
function listPhotos(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const t = photoTarget_(p.target, p.targetId);
    return { photos: withThumbs_(photoRows_(t.label, t.id)).map(function (r) { return photoForClient_(r, me); }), max: PHOTO_MAX_PER_RECORD };
  });
}

/**
 * 記録に写真を付ける。画面が JPEG に直して小さくしたものを送ってくる。
 * @param {{token:string, target:string, targetId:string, base64:string, thumb:string}} params
 */
function uploadPhoto(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    // 書類のスキャンを1つのPDFにまとめたもの（v0.30.0）も、写真と同じく記録に付ける
    const isFile = p.kind === 'file';       // v0.103.0 社内メモに付ける、PDF・Excelなどのファイル
    const isPdf = p.kind === 'pdf';
    let fileName = '', fileExt = '', fileMime = '';
    if (isFile) {
      fileName = cleanText_(p.name).replace(/[\n\\\/:*?"<>|]/g, '_').slice(0, 100);
      const dot = fileName.lastIndexOf('.');
      fileExt = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
      const allowed = Object.prototype.hasOwnProperty.call(ATTACH_TYPES, fileExt) ? ATTACH_TYPES[fileExt] : null;
      if (!fileName || !allowed) throw appError_('invalid', 'この種類のファイルは添付できません。使えるのは ' + Object.keys(ATTACH_TYPES).join('・') + ' です。');
      const given = String(p.mimeType || '').toLowerCase();
      fileMime = allowed.indexOf(given) !== -1 ? given : allowed[0];
    }
    const bytes = decodeUpload_(p.base64, isFile ? ATTACH_MAX_BYTES : isPdf ? SCAN_PDF_MAX_BYTES : PHOTO_MAX_BYTES);
    if (isFile) { if (!looksLike_(bytes, fileExt)) throw appError_('invalid', 'ファイルの中身が、拡張子（.' + fileExt + '）と合っていません。'); }
    else if (isPdf ? !looksLike_(bytes, 'pdf') : !looksLike_(bytes, 'jpg')) throw appError_('invalid', isPdf ? 'PDFの形式が正しくありません。' : '写真の形式が正しくありません（JPEG にして送ってください）。');
    const pages = isPdf ? Math.max(1, Math.min(SCAN_PDF_MAX_PAGES, parseInt(p.pages, 10) || 1)) : 0;
    const thumb = isFile ? '' : cleanImageDataUrl_(p.thumb, PHOTO_THUMB_MAX_CHARS);
    return withLock_(function () {
      const headers = tableHead_(SHEET_ATTACH).headers;
      if (headers.indexOf('対象ID') === -1 || headers.indexOf('サムネイル') === -1) {
        throw appError_('setup', '添付のシートに、写真用の列がありません。スプレッドシートのメニューから「初期設定」をもう一度実行してください。');
      }
      const t = photoTarget_(p.target, p.targetId);
      const have = photoRows_(t.label, t.id).length;
      if (have >= PHOTO_MAX_PER_RECORD) throw appError_('invalid', '1つの記録に付けられる添付ファイルは' + PHOTO_MAX_PER_RECORD + '件までです。');
      const shared = getSettings_()['添付をリンクで共有する'] !== NO;
      const name = isFile ? t.id + '_' + fileName : (isPdf ? 'スキャン_' : '写真_') + t.label + '_' + t.id + '_' + nowStamp_().replace(/[- :]/g, '') + '_' + (have + 1) + (isPdf ? '_' + pages + 'p.pdf' : '.jpg');
      const mime = isFile ? fileMime : isPdf ? 'application/pdf' : 'image/jpeg';
      const file = filesFolder_().createFile(Utilities.newBlob(bytes, mime, name));
      if (shared) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const id = nextId_(SHEET_ATTACH, '添付ID', 'F', 5);
      const rec = {
        '添付ID': id, '顧客ID': t.customerId, 'ファイル名': name, 'DriveファイルID': file.getId(), 'サイズ': bytes.length, '種類': mime,
        'お客様に見せる': NO, '登録者': me.name, '登録日時': nowStamp_(), '対象区分': t.label, '対象ID': t.id, 'サムネイル': thumb, '登録者ID': me.id
      };
      appendRecord_(SHEET_ATTACH, rec);
      logAudit_(isFile ? '添付追加' : isPdf ? 'スキャンPDF追加' : '写真追加', id, t.customerId, t.label + ' ' + t.id, '', name, me.name);
      return { photo: photoForClient_(echoRow_(SHEET_ATTACH, null, rec), me) };
    });
  });
}

/** 写真の本体（画面で大きく見る時）。ドライブから読んで渡すので、リンクで共有していなくても見られる。@param {{token:string, id:string}} params */
function getPhoto(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const row = attachById_(p.id);
    if (!row || !row['対象区分']) throw appError_('notfound', 'その写真が見つかりません。');
    let blob;
    try { blob = DriveApp.getFileById(row['DriveファイルID']).getBlob(); } catch (e) { throw appError_('notfound', '写真のファイルがドライブから見つかりません。'); }
    const mime = row['種類'] && row['種類'] !== 'image/jpeg' ? String(row['種類']) : 'image/jpeg';
    return { id: String(row['添付ID']), name: row['ファイル名'], mimeType: mime, base64: Utilities.base64Encode(blob.getBytes()) };
  });
}

/**
 * 記録の顧客を変えた時に、付いていた写真の顧客も合わせる（withLock_ の中で呼ぶこと）。
 * 「お客様に見せる」は「いいえ」に戻す（前の顧客に見せていたものが、そのまま新しい顧客のページに出ないように）。
 */
function movePhotosOf_(key, id, customerId) { movePhotosMany_([[key, id]], customerId); }
/**
 * いくつもの記録の写真（添付）を、まとめて別の顧客へ（v0.106.0。添付のシートは1回だけ読み、1回で書く）
 * @param {Array<Array>} pairs [[key, id], …]
 */
function movePhotosMany_(pairs, customerId) {
  const want = {};
  pairs.forEach(function (pr) {
    const def = Object.prototype.hasOwnProperty.call(PHOTO_TARGETS, pr[0]) ? PHOTO_TARGETS[pr[0]] : null;
    if (!def) return;
    want[def[2] + '|' + String(pr[1])] = true;
    if (pr[0] === 'device') want[REPORT_TARGET_LABEL + '|' + String(pr[1])] = true;
  });
  if (!Object.keys(want).length) return;
  const rows = attachRows_().filter(function (r) { return want[r['対象区分'] + '|' + String(r['対象ID'])]; }).map(function (r) { return r._row; });
  updateRowsSame_(SHEET_ATTACH, rows, { '顧客ID': customerId, 'お客様に見せる': NO });
}

/** 記録を消す時に、付いていた写真も消す（ドライブのファイルはゴミ箱へ）。withLock_ の中で呼ぶこと */
function removePhotosOf_(key, id) {
  const def = Object.prototype.hasOwnProperty.call(PHOTO_TARGETS, key) ? PHOTO_TARGETS[key] : null;
  if (!def) return 0;
  // 機器を消す時は、収集ツールのレポート（v0.25.0）も一緒に消す
  const rows = photoRows_(def[2], String(id)).concat(key === 'device' ? photoRows_(REPORT_TARGET_LABEL, String(id)) : []);
  rows.map(function (r) { trashFile_(r['DriveファイルID']); return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (rowNumber) { deleteRecord_(SHEET_ATTACH, rowNumber); });
  return rows.length;
}

// ---------------------------------------------------------------------------
// 会社のロゴ（設定シートの「ロゴ画像」に、小さくした画像を data URL で持つ）
// ---------------------------------------------------------------------------
function logoOf_(settings) {
  return cleanImageDataUrl_(settings[LOGO_SETTING_KEY], LOGO_MAX_CHARS);
}

/**
 * 会社のロゴを入れる・外す（管理者）。dataUrl を空にすると外す。
 * @param {{token:string, dataUrl:string}} params
 */
function saveLogo(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const raw = typeof p.dataUrl === 'string' ? p.dataUrl : '';
    const logo = raw ? cleanImageDataUrl_(raw, LOGO_MAX_CHARS) : '';
    if (raw && !logo) throw appError_('invalid', 'ロゴに使えるのは PNG・JPEG・WebP の画像です（大きすぎるものも使えません）。');
    return withLock_(function () {
      const row = readTable_(SHEET_SETTINGS).rows.filter(function (r) { return String(r['キー']).trim() === LOGO_SETTING_KEY; })[0];
      const had = !!(row && row['値']);
      if (row) updateRecord_(SHEET_SETTINGS, row._row, { '値': logo });
      else if (logo) appendRecord_(SHEET_SETTINGS, { 'キー': LOGO_SETTING_KEY, '値': logo, '説明': '会社のロゴ（画面の「設定」から入れる。ここは直接さわらない）' });
      if (had || logo) logAudit_('設定変更', LOGO_SETTING_KEY, '', LOGO_SETTING_KEY, had ? '（あり）' : '（なし）', logo ? '（あり）' : '（なし）', me.name);
      CacheService.getScriptCache().remove(BRAND_CACHE_KEY);
      return { logo: logo };
    });
  });
}

// ---------------------------------------------------------------------------
// レイアウト図
// ---------------------------------------------------------------------------
function layoutNum_(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

function layoutColor_(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

/** 回転（度）。0〜359 の整数にする。0 の時は持たせない（保存する量を増やさない） */
function layoutRot_(el, out) {
  const n = Number(el.r);
  if (!isFinite(n)) return out;
  const r = ((Math.round(n) % 360) + 360) % 360;
  if (r) out.r = r;
  return out;
}

/** 幹線図の記号の番号。英数字8字まで（長いものは切らずに、番号として認めない） */
function layoutId_(v) {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  return /^[A-Za-z0-9]{1,8}$/.test(s) ? s : '';
}

function layoutText_(v, max) {
  return typeof v === 'string' || typeof v === 'number' ? cleanText_(v, max).replace(/\n/g, ' ') : '';
}

/**
 * 画面から来た図形の一覧を検査して、決めた形だけにする。位置と大きさは図の幅・高さに対する％。
 * 知らない種類・他の顧客の機器を指すピンは捨てる。箱型・文字・アイコンは r（回転の度数）を持てる。
 */
function sanitizeLayoutElements_(elements, customerId) {
  if (!Array.isArray(elements)) throw appError_('invalid', '図形の形式が正しくありません。');
  if (elements.length > LAYOUT_MAX_ELEMENTS) throw appError_('invalid', '図形が多すぎます（' + LAYOUT_MAX_ELEMENTS + '個まで）。');
  const mine = {};
  readTable_(SHEET_DEVICES).rows.forEach(function (d) { if (String(d['顧客ID']) === String(customerId)) mine[String(d['機器ID'])] = true; });
  const out = [];
  const netIds = {};       // 幹線図の記号の番号（net.id）。回線（link）がつなぐ先の確かめに使う
  elements.forEach(function (el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return;
    const before = out.length;
    layoutOneElement_(el, mine, out, netIds);
    // v0.105.0：ロック・非表示・グループの印（回線には付けない）
    if (out.length > before) {
      const last = out[out.length - 1];
      if (last.type !== 'link') {
        if (el.lock === true) last.lock = true;
        if (el.hide === true) last.hide = true;
        const g = layoutId_(el.grp);
        if (g) last.grp = g;
      }
    }
  });
  // 1つしか残っていないグループは、印を外す
  const gcount = {};
  out.forEach(function (x) { if (x.grp) gcount[x.grp] = (gcount[x.grp] || 0) + 1; });
  out.forEach(function (x) { if (x.grp && gcount[x.grp] < 2) delete x.grp; });
  // 回線：つなぎ先の記号が無いもの、同じ2つをつなぐ2本目は捨てる（記号を消した後に残った回線を、ここでも掃除する）
  const pairs = {};
  return out.filter(function (el) {
    if (el.type !== 'link') return true;
    if (!netIds[el.a] || !netIds[el.b]) return false;
    const key = el.a < el.b ? el.a + '|' + el.b : el.b + '|' + el.a;
    if (pairs[key]) return false;
    pairs[key] = true;
    return true;
  });
}

/** 図形1つを検査して、よければ out に足す（捨てる時は何も足さない） */
function layoutOneElement_(el, mine, out, netIds) {
  {
    const type = String(el.type || '');
    const pos = { x: layoutNum_(el.x, -20, 120, 0), y: layoutNum_(el.y, -20, 120, 0) };
    if (type === 'pin') {
      const deviceId = layoutText_(el.deviceId, 20);
      if (!Object.prototype.hasOwnProperty.call(mine, deviceId)) return;
      out.push({ type: type, x: pos.x, y: pos.y, deviceId: deviceId });
    } else if (LAYOUT_BOX_TYPES.indexOf(type) !== -1) {
      out.push(layoutRot_(el, {
        type: type, x: pos.x, y: pos.y, w: layoutNum_(el.w, 1, 100, 10), h: layoutNum_(el.h, 1, 100, 8),
        color: layoutColor_(el.color, ''), text: layoutText_(el.text, 40)
      }));
    } else if (type === 'text') {
      const text = layoutText_(el.text, 100);
      if (!text) return;
      out.push(layoutRot_(el, { type: type, x: pos.x, y: pos.y, text: text, size: layoutNum_(el.size, 8, 48, 14), color: layoutColor_(el.color, '') }));
    } else if (type === 'icon') {
      if (LAYOUT_ICONS.indexOf(el.icon) === -1) return;
      out.push(layoutRot_(el, { type: type, x: pos.x, y: pos.y, icon: el.icon, size: layoutNum_(el.size, 12, 80, 28), text: layoutText_(el.text, 30) }));
    } else if (LAYOUT_LINE_TYPES.indexOf(type) !== -1) {
      out.push({
        type: type, x1: layoutNum_(el.x1, -20, 120, 0), y1: layoutNum_(el.y1, -20, 120, 0),
        x2: layoutNum_(el.x2, -20, 120, 0), y2: layoutNum_(el.y2, -20, 120, 0),
        color: layoutColor_(el.color, ''), width: layoutNum_(el.width, 1, 8, 2)
      });
    } else if (type === 'net') {
      // ネットワーク機器の記号：番号は英数字8字まで・重なったら後ろを捨てる。機器との結びつきは、この顧客の機器だけ
      const id = layoutId_(el.id);
      if (!id || Object.prototype.hasOwnProperty.call(netIds, id)) return;
      if (LAYOUT_NET_KINDS.indexOf(el.kind) === -1) return;
      const devId = layoutText_(el.deviceId, 20);
      netIds[id] = true;
      out.push({
        type: type, id: id, kind: el.kind, x: pos.x, y: pos.y, size: layoutNum_(el.size, 16, 60, 28),
        text: layoutText_(el.text, 30), ip: layoutText_(el.ip, 45), note: layoutText_(el.note, 60),
        deviceId: Object.prototype.hasOwnProperty.call(mine, devId) ? devId : ''
      });
    } else if (type === 'link') {
      // 回線：記号の番号 a と b をつなぐ。後で、つなぎ先が無いもの・同じ組み合わせの2本目を捨てる
      const a = layoutId_(el.a), b = layoutId_(el.b);
      if (!a || !b || a === b || LAYOUT_LINK_KINDS.indexOf(el.kind) === -1) return;
      out.push({ type: type, a: a, b: b, kind: el.kind, text: layoutText_(el.text, 20) });
    } else if (type === 'poly') {
      // 折れ線：点は [x, y] の並び。2点に満たない・多すぎる・形が違うものは捨てる
      if (!Array.isArray(el.points) || el.points.length < 2 || el.points.length > LAYOUT_POLY_MAX_POINTS) return;
      const bad = el.points.some(function (pt) { return !Array.isArray(pt) || pt.length !== 2 || !isFinite(Number(pt[0])) || !isFinite(Number(pt[1])) || pt[0] === null || pt[1] === null; });
      if (bad) return;
      out.push({
        type: type, points: el.points.map(function (pt) { return [layoutNum_(pt[0], -20, 120, 0), layoutNum_(pt[1], -20, 120, 0)]; }),
        color: layoutColor_(el.color, ''), width: layoutNum_(el.width, 1, 8, 2)
      });
    }
  }
}

function layoutElementsOf_(row) {
  try {
    const list = JSON.parse(row['図形'] || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function layoutSummary_(row) {
  return {
    'レイアウトID': row['レイアウトID'], '顧客ID': row['顧客ID'], '名前': row['名前'], '更新日時': row['更新日時'],
    hasImage: !!row['画像ファイルID'], count: layoutElementsOf_(row).length
  };
}

function layoutsOf_(customerId) {
  return readTable_(SHEET_LAYOUTS).rows.filter(function (r) { return String(r['顧客ID']) === String(customerId); });
}

/** レイアウト1枚ぶんを、画面に渡す形にする（背景画像はここでドライブから読む） */
function layoutPayload_(row) {
  const out = {
    'レイアウトID': row['レイアウトID'], '顧客ID': row['顧客ID'], '名前': row['名前'], '更新日時': row['更新日時'],
    backgroundColor: layoutColor_(row['背景色'], '#ffffff'), elements: layoutElementsOf_(row),
    imageBase64: '', imageMimeType: '', imageMissing: false
  };
  if (row['画像ファイルID']) {
    try {
      const blob = DriveApp.getFileById(row['画像ファイルID']).getBlob();
      out.imageBase64 = Utilities.base64Encode(blob.getBytes());
      out.imageMimeType = LAYOUT_IMAGE_TYPES.indexOf(blob.getContentType()) !== -1 ? blob.getContentType() : 'image/png';
    } catch (e) {
      console.error('レイアウトの画像を読めません: ' + e);
      out.imageMissing = true;
    }
  }
  return out;
}

function layoutName_(v) {
  const name = cleanText_(v).replace(/\n/g, ' ');
  if (!name) throw appError_('invalid', 'レイアウトの名前を入れてください。');
  if (name.length > 40) throw appError_('invalid', 'レイアウトの名前は40文字までです。');
  return name;
}

/** 顧客のレイアウトの一覧。@param {{token:string, customerId:string}} params */
function listLayouts(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    return { layouts: layoutsOf_(cleanText_(p.customerId)).map(layoutSummary_) };
  });
}

/** レイアウト1枚（図形と背景画像）。@param {{token:string, layoutId:string}} params */
function getLayout(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
    if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。');
    return { layout: layoutPayload_(row) };
  });
}

/** レイアウトを新しく作る。@param {{token:string, customerId:string, name:string}} params */
function createLayout(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const name = layoutName_(p.name);
    return withLock_(function () {
      const customer = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!customer) throw appError_('invalid', '顧客が見つかりません。');
      if (layoutsOf_(customer['顧客ID']).length >= LAYOUT_MAX_PER_CUSTOMER) {
        throw appError_('invalid', '1つの顧客に作れるレイアウトは' + LAYOUT_MAX_PER_CUSTOMER + '枚までです。');
      }
      const id = nextId_(SHEET_LAYOUTS, 'レイアウトID', 'LY', 4);
      const now = nowStamp_();
      appendRecord_(SHEET_LAYOUTS, { 'レイアウトID': id, '顧客ID': customer['顧客ID'], '名前': name, '背景色': '#ffffff', '図形': '[]', '登録日時': now, '更新日時': now });
      logAudit_('レイアウト追加', id, customer['顧客ID'], '', '', name, me.name);
      return { layout: layoutSummary_(findById_(SHEET_LAYOUTS, 'レイアウトID', id)) };
    });
  });
}

/** レイアウトの名前を変える。@param {{token:string, layoutId:string, name:string}} params */
function renameLayout(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const name = layoutName_(p.name);
    return withLock_(function () {
      const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。');
      if (row['名前'] !== name) {
        updateRecord_(SHEET_LAYOUTS, row._row, { '名前': name, '更新日時': nowStamp_() });
        logAudit_('レイアウト変更', row['レイアウトID'], row['顧客ID'], '名前', row['名前'], name, me.name);
      }
      return { layout: layoutSummary_(findById_(SHEET_LAYOUTS, 'レイアウトID', row['レイアウトID'])) };
    });
  });
}

/** レイアウトを消す（管理者）。@param {{token:string, layoutId:string}} params */
function deleteLayout(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。');
      trashFile_(row['画像ファイルID']);
      deleteRecord_(SHEET_LAYOUTS, row._row);
      logAudit_('レイアウト削除', row['レイアウトID'], row['顧客ID'], '', row['名前'] + '（図形 ' + layoutElementsOf_(row).length + '個）', '', me.name);
      return { id: String(row['レイアウトID']) };
    });
  });
}

/**
 * 図形と背景色を保存する。
 * @param {{token:string, layoutId:string, elements:Array<Object>, backgroundColor:string}} params
 */
function saveLayout(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。他の人が消した可能性があります。');
      const elements = sanitizeLayoutElements_(p.elements, row['顧客ID']);
      const json = JSON.stringify(elements);
      if (json.length > LAYOUT_MAX_JSON) throw appError_('invalid', '図形が多すぎて保存できません。レイアウトを分けてください。');
      const now = nowStamp_();
      updateRecord_(SHEET_LAYOUTS, row._row, { '図形': json, '背景色': layoutColor_(p.backgroundColor, '#ffffff'), '更新日時': now });
      logAudit_('レイアウト保存', row['レイアウトID'], row['顧客ID'], '', '図形 ' + layoutElementsOf_(row).length + '個', '図形 ' + elements.length + '個', me.name);
      return { elements: elements, updatedAt: now };
    });
  });
}

/**
 * 背景の画像を入れ替える。
 * @param {{token:string, layoutId:string, mimeType:string, base64:string}} params
 */
function saveLayoutImage(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const mimeType = String(p.mimeType || '').toLowerCase();
    const ext = imageExt_(mimeType);
    if (!ext) throw appError_('invalid', '背景に使える画像は PNG・JPEG・GIF・WebP です。');
    const bytes = decodeUpload_(p.base64, LAYOUT_IMAGE_MAX_BYTES);
    if (!looksLike_(bytes, ext)) throw appError_('invalid', '画像の中身が、種類（' + ext + '）と合っていません。');
    return withLock_(function () {
      const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。');
      const file = filesFolder_().createFile(Utilities.newBlob(bytes, mimeType, 'layout_' + row['レイアウトID'] + '.' + ext));
      trashFile_(row['画像ファイルID']);
      updateRecord_(SHEET_LAYOUTS, row._row, { '画像ファイルID': file.getId(), '更新日時': nowStamp_() });
      logAudit_('レイアウト画像の入れ替え', row['レイアウトID'], row['顧客ID'], '', '', Math.round(bytes.length / 1024) + 'KB', me.name);
      return { imageBase64: p.base64, imageMimeType: mimeType };
    });
  });
}

/** 背景の画像を外す。@param {{token:string, layoutId:string}} params */
function removeLayoutImage(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。');
      if (row['画像ファイルID']) {
        trashFile_(row['画像ファイルID']);
        updateRecord_(SHEET_LAYOUTS, row._row, { '画像ファイルID': '', '更新日時': nowStamp_() });
        logAudit_('レイアウト画像の削除', row['レイアウトID'], row['顧客ID'], '', '', '', me.name);
      }
      return {};
    });
  });
}
