/**
 * Feed.gs … Windows情報と Tips の自動更新（配信フォルダーから読み込む）
 *
 * しくみ
 *   1. Google ドライブに「配信フォルダー」を1つ決めて、設定の「配信フォルダー」に入れる。
 *   2. そのフォルダーに、配信ファイル（ふつうのテキストファイル）が増える。
 *      （毎週の定期タスクが、Windows Update・ドライバーの不具合を調べて、1つずつ置いていく）
 *   3. アプリが、まだ読んでいないファイルを見つけて、Windows情報と Tips に取り込む。
 *      確かめるのは、スタッフが画面を開いたとき（6時間に1回まで）と、毎朝の通知の処理のとき。
 *
 * 配信ファイルの書き方（1行に1件。# で始まる行は読み飛ばす）
 *   INFO｜日付｜種類｜重要度｜タイトル｜内容｜リンク
 *   TIP｜見出し｜説明
 *   （頭の INFO を省いて、日付から書いてもよい。「まとめて貼り付け」と同じ形）
 *
 * 取り込んだ Windows情報は、「顧客に見せる：いいえ」で入る。スタッフが確かめてから「はい」にする。
 *
 * 公開関数：refreshFeed
 */
const FEED_DONE_PROPERTY = 'FEED_DONE';        // 読み終えたファイル {ファイルID: 更新時刻}
const FEED_STATUS_PROPERTY = 'FEED_STATUS';    // 最後に確かめた結果
const FEED_CACHE_KEY = 'feedChecked';
const TIPS_CACHE_KEY = 'tips';

/** 設定の「配信フォルダー」から、フォルダーのIDを取り出す（URL を貼ってもよい） */
function feedFolderId_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /\/folders\/([A-Za-z0-9_-]{10,100})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,100})/.exec(s) || /^([A-Za-z0-9_-]{10,100})$/.exec(s);
  return m ? m[1] : '';
}

/**
 * 配信ファイルの中身を、Windows情報と Tips に分ける。
 * @return {{infos:Array<Object>, tips:Array<Array<string>>, bad:number}}
 */
function parseFeed_(text) {
  const out = { infos: [], tips: [], bad: 0 };
  String(text || '').split(/\r?\n/).forEach(function (raw) {
    if (raw.length > FEED_MAX_LINE) { out.bad++; return; }
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.charAt(0) === '#') return;
    const c = line.split(/[｜|]/).map(function (x) { return x.trim(); });
    const head = String(c[0]).toUpperCase();
    if (head === 'TIP') {
      if (c.length >= 3 && c[1] && c[2] && out.tips.length < FEED_MAX_TIPS_PER_FILE) out.tips.push([c[1], c[2]]); else out.bad++;
      return;
    }
    const f = head === 'INFO' ? c.slice(1) : c;
    if (f.length < 4 || out.infos.length >= WININFO_IMPORT_MAX) { out.bad++; return; }
    // 配信の文が少し長くても、行ごと捨てずに、決めた長さで切る
    out.infos.push({
      '日付': f[0], '種類': WININFO_KINDS.indexOf(f[1]) !== -1 ? f[1] : 'その他', '重要度': NOTICE_LEVELS.indexOf(f[2]) !== -1 ? f[2] : '通常',
      'タイトル': String(f[3]).slice(0, 60), '内容': String(f[4] || '').slice(0, 300), 'リンク': f[5] || ''
    });
  });
  return out;
}

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

function feedStatus_() {
  let st = null;
  try { st = JSON.parse(PropertiesService.getScriptProperties().getProperty(FEED_STATUS_PROPERTY) || 'null'); } catch (e) { st = null; }
  return st && typeof st === 'object' ? { at: String(st.at || ''), ok: !!st.ok, message: String(st.message || ''), added: Number(st.added) || 0, tips: Number(st.tips) || 0 } : null;
}

/** 配信フォルダーを確かめる間隔（秒）。設定「配信を確かめる間隔（時間）」1〜6（キャッシュは6時間まで）、変なら6時間（v0.31.0） */
function feedCheckSeconds_(settings) {
  const h = parseInt(settings && settings['配信を確かめる間隔（時間）'], 10);
  return isFinite(h) && h >= 1 && h <= 6 ? h * 3600 : FEED_CHECK_SECONDS;
}

/** 管理画面に出す、配信の状態 */
function feedForClient_(settings) {
  return { on: !!feedFolderId_(settings['配信フォルダー']), status: feedStatus_(), hours: feedCheckSeconds_(settings) / 3600 };
}

/**
 * 配信フォルダーを確かめて、まだ読んでいないファイルを取り込む。
 * @param {boolean} force true なら、6時間待たずに確かめる
 * @return {{on:boolean, checked:boolean, added:number, tips:number, files:number, message:string}}
 */
function refreshFeedCore_(force) {
  const settings = getSettings_();
  const folderId = feedFolderId_(settings['配信フォルダー']);
  const takeInfo = settings['Windows情報を取り込む'] !== NO;
  const takeTips = settings['Tipsを取り込む'] !== NO;
  const showInfo = settings['取り込んだWindows情報をお客様に見せる'] === YES ? YES : NO;
  const none = { on: !!folderId, checked: false, added: 0, tips: 0, files: 0, message: '' };
  if (!folderId) return none;
  const cache = CacheService.getScriptCache();
  if (!force && cache.get(FEED_CACHE_KEY) === folderId) return none;
  cache.put(FEED_CACHE_KEY, folderId, feedCheckSeconds_(settings));

  const props = PropertiesService.getScriptProperties();
  const finish = function (ok, message, added, tips, files) {
    props.setProperty(FEED_STATUS_PROPERTY, JSON.stringify({ at: nowStamp_(), ok: ok, message: message, added: added, tips: tips }));
    return { on: true, checked: true, added: added, tips: tips, files: files, message: message };
  };

  // ドライブから読む（ここはロックの外。遅いので、ほかの人の保存を待たせない）
  // 読み終えた記録は {ファイルID: [更新時刻, 中身の印]}。更新時刻が同じなら読まない。
  // 時刻だけ変わって中身が同じ（名前を変えた・移した）なら、読み直さない。
  let done = {};
  try { done = JSON.parse(props.getProperty(FEED_DONE_PROPERTY) || '{}') || {}; } catch (e) { done = {}; }
  if (!done || typeof done !== 'object' || Array.isArray(done)) done = {};
  const isDone = function (id) { return Object.prototype.hasOwnProperty.call(done, id) && Array.isArray(done[id]) ? done[id] : null; };
  let recent;
  try {
    const since = Date.now() - FEED_KEEP_DAYS * 86400000;
    const it = DriveApp.getFolderById(folderId).getFiles();
    const found = [];
    let seen = 0;
    while (it.hasNext() && seen < 2000) {
      seen++;
      const f = it.next();
      if (f.isTrashed()) continue;
      if (String(f.getMimeType() || '').indexOf('text/') !== 0) continue;      // ふつうのテキストファイルだけ
      const updated = f.getLastUpdated().getTime();
      if (updated < since) continue;                                             // 古いファイルは見ない
      found.push({ id: f.getId(), updated: updated, file: f });
    }
    // 新しいものから FEED_KEEP_FILES 個までを相手にする
    recent = found.sort(function (a, b) { return b.updated - a.updated; }).slice(0, FEED_KEEP_FILES);
  } catch (e) {
    console.error('配信フォルダーを読めませんでした: ' + (e && e.stack ? e.stack : e));
    cache.remove(FEED_CACHE_KEY);      // うまくいかなかったときは、次に開いたときにもう一度確かめる
    return finish(false, '配信フォルダーを開けませんでした。フォルダーのIDと、共有（このスクリプトを動かしているアカウントで開けるか）を確かめてください。', 0, 0, 0);
  }
  // まだ読んでいないものを、古い順に。1回に読むのは FEED_MAX_FILES 個まで（残りは次の回）
  const pending = recent.filter(function (x) { const d = isDone(x.id); return !d || d[0] !== x.updated; })
    .sort(function (a, b) { return a.updated - b.updated; }).slice(0, FEED_MAX_FILES);
  let unreadable = 0;
  pending.forEach(function (x) {
    // 1つのファイルが読めなくても、ほかのファイルは読む（読めなかったファイルは、読み終えた扱いにして、くり返さない）
    x.parsed = null; x.hash = '';
    try {
      if (x.file.getSize() > FEED_MAX_CHARS * 4) { unreadable++; return; }
      const text = x.file.getBlob().getDataAsString('UTF-8');
      x.hash = sha256Hex_(text).slice(0, 16);
      if (text.length > FEED_MAX_CHARS) { unreadable++; return; }
      const d = isDone(x.id);
      x.same = !!d && d[1] === x.hash;      // 中身は前と同じ
      if (!x.same) x.parsed = parseFeed_(text);
    } catch (e) {
      console.error('配信ファイルを読めませんでした（' + x.id + '）: ' + (e && e.message ? e.message : e));
      unreadable++;
    }
  });
  if (!pending.length) return finish(true, '新しい配信ファイルはありませんでした。', 0, 0, 0);

  const me = { id: 'feed', name: '自動更新', role: ROLE_STAFF, isAdmin: false };
  try {
    return withLock_(function () {
      let added = 0, tips = 0, bad = unreadable, tipsDropped = 0;
      pending.forEach(function (p) {
        if (p.parsed) {
          bad += p.parsed.bad;
          if (takeInfo) { const r = addWinInfoRows_(p.parsed.infos, showInfo, me); added += r.added; bad += r.errors.length; }
          if (takeTips) { const t = addTipRows_(p.parsed.tips); tips += t.added; tipsDropped += t.full; }
        }
        done[p.id] = [p.updated, p.hash];
      });
      // 記録は、いまフォルダーにある新しいファイルのぶんだけ持つ（増えつづけないように）
      const keep = {};
      recent.forEach(function (x) { const d = isDone(x.id); if (d) keep[x.id] = d; });
      props.setProperty(FEED_DONE_PROPERTY, JSON.stringify(keep));
      if (added || tips) logAudit_('配信の取り込み', 'ファイル ' + pending.length + '個', '', '', '', 'Windows情報 ' + added + '件、Tips ' + tips + '件', me.name);
      return finish(true, 'ファイル ' + pending.length + '個を読みました。Windows情報 ' + added + '件、Tips ' + tips + '件を足しました。' +
        (bad ? '（読めなかった行・ファイル ' + bad + '）' : '') + (tipsDropped ? '（Tips がいっぱいで、' + tipsDropped + '件は入れていません）' : ''), added, tips, pending.length);
    });
  } catch (e) {
    cache.remove(FEED_CACHE_KEY);      // ほかの保存と重なったときなどは、次に開いたときにもう一度
    throw e;
  }
}

/**
 * 配信フォルダーを確かめる（スタッフ）。画面を開いたときに、裏で呼ばれる。force:true は「いますぐ更新」。
 * @param {{token:string, force:boolean}} params
 */
function refreshFeed(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const r = refreshFeedCore_(p.force === true);
    const settings = getSettings_();
    const out = { on: r.on, checked: r.checked, added: r.added, addedTips: r.tips, message: r.message, feed: feedForClient_(settings) };
    // 何か足したときだけ、新しい一覧を返す
    if (r.added || p.force === true) out.wininfo = sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (x) { return publicRecord_(x); });
    if (r.tips || p.force === true) out.tips = tipsForClient_(settings);
    return out;
  });
}
