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
      // 消せるのは管理者。記録に付けた写真だけは、付けた本人も消せる（撮りまちがいを直せるように）
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
  if (!def) throw appError_('invalid', '写真を付けられるのは、対応・修理・機器・ライセンス・保守です。');
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
    const isPdf = p.kind === 'pdf';
    const bytes = decodeUpload_(p.base64, isPdf ? SCAN_PDF_MAX_BYTES : PHOTO_MAX_BYTES);
    if (isPdf ? !looksLike_(bytes, 'pdf') : !looksLike_(bytes, 'jpg')) throw appError_('invalid', isPdf ? 'PDFの形式が正しくありません。' : '写真の形式が正しくありません（JPEG にして送ってください）。');
    const pages = isPdf ? Math.max(1, Math.min(SCAN_PDF_MAX_PAGES, parseInt(p.pages, 10) || 1)) : 0;
    const thumb = cleanImageDataUrl_(p.thumb, PHOTO_THUMB_MAX_CHARS);
    return withLock_(function () {
      const headers = tableHead_(SHEET_ATTACH).headers;
      if (headers.indexOf('対象ID') === -1 || headers.indexOf('サムネイル') === -1) {
        throw appError_('setup', '添付のシートに、写真用の列がありません。スプレッドシートのメニューから「初期設定」をもう一度実行してください。');
      }
      const t = photoTarget_(p.target, p.targetId);
      const have = photoRows_(t.label, t.id).length;
      if (have >= PHOTO_MAX_PER_RECORD) throw appError_('invalid', '1つの記録に付けられる写真は' + PHOTO_MAX_PER_RECORD + '枚までです。');
      const shared = getSettings_()['添付をリンクで共有する'] !== NO;
      const name = (isPdf ? 'スキャン_' : '写真_') + t.label + '_' + t.id + '_' + nowStamp_().replace(/[- :]/g, '') + '_' + (have + 1) + (isPdf ? '_' + pages + 'p.pdf' : '.jpg');
      const mime = isPdf ? 'application/pdf' : 'image/jpeg';
      const file = filesFolder_().createFile(Utilities.newBlob(bytes, mime, name));
      if (shared) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const id = nextId_(SHEET_ATTACH, '添付ID', 'F', 5);
      const rec = {
        '添付ID': id, '顧客ID': t.customerId, 'ファイル名': name, 'DriveファイルID': file.getId(), 'サイズ': bytes.length, '種類': mime,
        'お客様に見せる': NO, '登録者': me.name, '登録日時': nowStamp_(), '対象区分': t.label, '対象ID': t.id, 'サムネイル': thumb, '登録者ID': me.id
      };
      appendRecord_(SHEET_ATTACH, rec);
      logAudit_(isPdf ? 'スキャンPDF追加' : '写真追加', id, t.customerId, t.label + ' ' + t.id, '', name, me.name);
      return { photo: photoForClient_(echoRow_(SHEET_ATTACH, null, rec), me) };
    });
  });
}

/** 写真の本体（画面で大きく見るとき）。ドライブから読んで渡すので、リンクで共有していなくても見られる。@param {{token:string, id:string}} params */
function getPhoto(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const row = attachById_(p.id);
    if (!row || !row['対象区分']) throw appError_('notfound', 'その写真が見つかりません。');
    let blob;
    try { blob = DriveApp.getFileById(row['DriveファイルID']).getBlob(); } catch (e) { throw appError_('notfound', '写真のファイルがドライブから見つかりません。'); }
    const mime = row['種類'] === 'application/pdf' ? 'application/pdf' : 'image/jpeg';
    return { id: String(row['添付ID']), name: row['ファイル名'], mimeType: mime, base64: Utilities.base64Encode(blob.getBytes()) };
  });
}

/**
 * 記録の顧客を変えたときに、付いていた写真の顧客も合わせる（withLock_ の中で呼ぶこと）。
 * 「お客様に見せる」は「いいえ」に戻す（前の顧客に見せていたものが、そのまま新しい顧客のページに出ないように）。
 */
function movePhotosOf_(key, id, customerId) {
  const def = Object.prototype.hasOwnProperty.call(PHOTO_TARGETS, key) ? PHOTO_TARGETS[key] : null;
  if (!def) return;
  photoRows_(def[2], String(id)).concat(key === 'device' ? photoRows_(REPORT_TARGET_LABEL, String(id)) : []).forEach(function (r) {
    updateRecord_(SHEET_ATTACH, r._row, { '顧客ID': customerId, 'お客様に見せる': NO });
  });
}

/** 記録を消すときに、付いていた写真も消す（ドライブのファイルはゴミ箱へ）。withLock_ の中で呼ぶこと */
function removePhotosOf_(key, id) {
  const def = Object.prototype.hasOwnProperty.call(PHOTO_TARGETS, key) ? PHOTO_TARGETS[key] : null;
  if (!def) return 0;
  // 機器を消すときは、収集ツールのレポート（v0.25.0）も一緒に消す
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

/** 回転（度）。0〜359 の整数にする。0 のときは持たせない（保存する量を増やさない） */
function layoutRot_(el, out) {
  const n = Number(el.r);
  if (!isFinite(n)) return out;
  const r = ((Math.round(n) % 360) + 360) % 360;
  if (r) out.r = r;
  return out;
}

function layoutText_(v, max) {
  return typeof v === 'string' || typeof v === 'number' ? cleanText_(v, max).replace(/\n/g, ' ') : '';
}

/**
 * 画面から来た図形の一覧を検査して、決めた形だけにする。位置と大きさは図の幅・高さに対する％。
 * 知らない種類・ほかの顧客の機器を指すピンは捨てる。箱型・文字・アイコンは r（回転の度数）を持てる。
 */
function sanitizeLayoutElements_(elements, customerId) {
  if (!Array.isArray(elements)) throw appError_('invalid', '図形の形式が正しくありません。');
  if (elements.length > LAYOUT_MAX_ELEMENTS) throw appError_('invalid', '図形が多すぎます（' + LAYOUT_MAX_ELEMENTS + '個まで）。');
  const mine = {};
  readTable_(SHEET_DEVICES).rows.forEach(function (d) { if (String(d['顧客ID']) === String(customerId)) mine[String(d['機器ID'])] = true; });
  const out = [];
  elements.forEach(function (el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return;
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
  });
  return out;
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
      if (!row) throw appError_('notfound', 'そのレイアウトが見つかりません。ほかの人が消した可能性があります。');
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
