/**
 * Auth.gs … スタッフのログイン、セッション、スタッフ管理
 *
 * - パスワードはハッシュ（ソルト付き・繰り返しSHA-256）だけをシートに持つ
 * - ログインするとサーバーがセッショントークンを出す。以降の呼び出しはトークンで本人確認する
 *   （パスワードを毎回送らない。ブラウザに保存もしない）
 * - 「ログインしたままにする」を選んだ端末には、サーバーが長い合言葉（64桁）を出す。端末はそれだけを覚える
 *   （パスワードは端末に残さない）。サーバーは合言葉のハッシュだけを、スクリプトのプロパティに持つ（シートには書かない）。
 *   ログアウト・パスワードの変更・スタッフの無効化・期限（REMEMBER_DAYS 日）で、使えなくなる
 * - 公開関数：login / loginWithRemember / logout / changeMyPassword / saveMyStartView / saveMyView / listStaff / saveStaff / resetStaffPassword
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Auth.gs'] = '0.138.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

// ---------------------------------------------------------------------------
// ハッシュ・乱数
// ---------------------------------------------------------------------------
function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i]; // GASのバイトは符号付き（-128〜127）
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/** 64文字の16進（UUIDv4を2つ） */
function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

/**
 * SHA-256 を、GAS のサービスを呼ばずに計算する（結果は Utilities.computeDigest と同じ）。
 * パスワードの確認は300回くり返すので、1回ずつサービスを呼ぶと、ログインが1秒前後かかっていた（v0.88.0）。
 */
const SHA256_K_ = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
function utf8Bytes_(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function sha256HexJs_(text) {
  const bytes = utf8Bytes_(text);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) | 0;
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K_[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
  return hex;
}

function hashPassword_(password, salt, rounds) {
  let h = sha256HexJs_(salt + ':' + password);
  for (let i = 0; i < rounds; i++) h = sha256HexJs_(h + ':' + salt);
  return h;
}

function makePasswordHash_(password) {
  const salt = newToken_().slice(0, 16);
  return 'v1$' + PASSWORD_HASH_ROUNDS + '$' + salt + '$' + hashPassword_(password, salt, PASSWORD_HASH_ROUNDS);
}

function verifyPassword_(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const rounds = parseInt(parts[1], 10);
  if (!(rounds >= 1 && rounds <= 5000)) return false;
  const got = hashPassword_(password, parts[2], rounds);
  const want = parts[3];
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** 読み間違えにくい文字だけの仮パスワード */
function randomPassword_(length) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < length) {
    const hex = newToken_();
    for (let i = 0; i + 1 < hex.length && out.length < length; i += 2) {
      out += chars.charAt(parseInt(hex.substr(i, 2), 16) % chars.length);
    }
  }
  return out;
}

function checkNewPassword_(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN_LENGTH) {
    throw appError_('invalid', 'パスワードは' + PASSWORD_MIN_LENGTH + '文字以上にしてください。');
  }
  if (pw.length > 200) throw appError_('invalid', 'パスワードが長すぎます。');
}

// ---------------------------------------------------------------------------
// スタッフ
// ---------------------------------------------------------------------------
function normStaffId_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function isValidStaffId_(id) {
  // メールアドレスの形（yu-ya@en-grow.jp など）も使えるようにしている。頭は英数字
  return /^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(id);
}

function findStaff_(staffId) {
  const id = normStaffId_(staffId);
  if (!id) return null;
  const rows = readTable_(SHEET_STAFF).rows;
  for (let i = 0; i < rows.length; i++) {
    if (normStaffId_(rows[i]['スタッフID']) === id) return rows[i];
  }
  return null;
}

function staffPublic_(row) {
  return {
    'スタッフID': row['スタッフID'],
    '表示名': row['表示名'],
    '権限': row['権限'],
    '有効': row['有効'],
    '最終ログイン': row['最終ログイン']
  };
}

/** パスワードが変わったら古いセッションを無効にするための印 */
function passwordStamp_(hash) {
  return String(hash || '').slice(-12);
}

// ---------------------------------------------------------------------------
// 仮パスワード（v0.128.0）
//   仮パスワードを出したとき（スタッフの追加・パスワードの再設定・最初の管理者）、そのパスワードの印をスクリプトのプロパティに残す。
//   ログインした時、今のパスワードの印と同じなら「仮パスワードのまま」として、画面がパスワードの変更を促す。
//   本人がパスワードを変えると印が合わなくなるので、自動で出なくなる（シートの列は増やさない）。
// ---------------------------------------------------------------------------
const TEMP_PW_PREFIX = 'tmppw_';
function tempPwKey_(staffId) { return TEMP_PW_PREFIX + sha256Hex_('temp:' + normStaffId_(staffId)).slice(0, 40); }
/** 仮パスワードを出した時に呼ぶ */
function markTempPassword_(staffId, hash) {
  try { PropertiesService.getScriptProperties().setProperty(tempPwKey_(staffId), passwordStamp_(hash)); }
  catch (e) { console.warn('仮パスワードの印を残せませんでした: ' + e); }
}
/**
 * 本人がパスワードを変えた時に呼ぶ。「このパスワードは仮ではない」と、新しいパスワードの印と一緒に覚える。
 * （v0.128.2：パスワードの印と一緒に覚えるので、そのあと別の方法でパスワードが変わったら、覚えた結果は使わずに確かめ直す）
 */
function clearTempPassword_(staffId, newHash) {
  try { PropertiesService.getScriptProperties().setProperty(tempPwKey_(staffId), TEMP_PW_NOT + passwordStamp_(newHash)); } catch (e) { /* 印が合わないので、残っても出ない */ }
}
const TEMP_PW_NOT = 'no:';

/**
 * そのスタッフ（シートの行）が、仮パスワードのままか。
 * v0.128.1：印がまだ無い人（v0.128.0 より前に仮パスワードを出した人）は、変更履歴から1回だけ確かめる。
 *   一番新しい「パスワード再設定」「スタッフ追加」が、本人の「パスワード変更」より後なら、仮パスワードのまま。
 *   確かめた結果は印に残すので、次からは変更履歴を読まない。
 */
function isTempPassword_(staff) {
  if (!staff || !staff['パスワードハッシュ']) return false;
  const stamp = passwordStamp_(staff['パスワードハッシュ']);
  try {
    const props = PropertiesService.getScriptProperties();
    const key = tempPwKey_(staff['スタッフID']);
    const mark = props.getProperty(key);
    if (mark === stamp) return true;                       // 仮パスワードを出した時の印と同じ
    if (mark === TEMP_PW_NOT + stamp) return false;        // このパスワードは、仮ではないと確かめ済み
    // 印が無い・パスワードが印の後で変わった（印を付けない方法で再設定された など）：変更履歴で確かめ直す
    const temp = auditSaysTempPassword_(staff['スタッフID']);
    props.setProperty(key, temp ? stamp : TEMP_PW_NOT + stamp);
    return temp;
  } catch (e) {
    console.warn('仮パスワードかどうか確かめられませんでした: ' + e);
    return false;
  }
}

/**
 * 変更履歴から、そのスタッフのパスワードが仮パスワードのままかを見る（v0.128.1）。
 * 「パスワード再設定」「スタッフ追加」（仮パスワードを出した）と、本人の「パスワード変更」のうち、一番新しいもので決める。
 * 変更履歴にどれも無い（退避シートへ移した・最初の管理者）ときは、仮パスワードとは見なさない。
 */
function auditSaysTempPassword_(staffId) {
  const ids = [String(staffId), normStaffId_(staffId)].filter(function (v, i, all) { return v && all.indexOf(v) === i; });
  const kinds = { 'パスワード再設定': true, 'スタッフ追加': true, 'パスワード変更': false };
  let latest = null;
  ids.forEach(function (id) {
    rowsWhere_(SHEET_AUDIT, '対象', id).forEach(function (r) {
      if (!Object.prototype.hasOwnProperty.call(kinds, r['種別'])) return;
      const at = String(r['日時'] || '');
      if (!latest || at > latest.at || (at === latest.at && r._row > latest.row)) latest = { at: at, row: r._row, temp: kinds[r['種別']] };
    });
  });
  return !!(latest && latest.temp);
}

// ---------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------
function sessionKey_(token) {
  return 'sess_' + token;
}

function putSession_(token, staffRow, issuedAt) {
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify({
    id: normStaffId_(staffRow['スタッフID']),
    stamp: passwordStamp_(staffRow['パスワードハッシュ']),
    at: issuedAt
  }), SESSION_SECONDS);
}

/**
 * トークンから本人を確認する。スタッフは控え（Cache.gs の refStaff）から見る。アプリでの無効化・権限変更・パスワード変更は
 * すぐ効く（書いたら控えの印が変わる）。シートを手で直したときも onEdit で、行を消したときなどでも90秒以内に効く。
 * @param {string} token
 * @param {boolean=} needAdmin 管理者だけに許す操作なら true
 * @return {{id:string, name:string, role:string, isAdmin:boolean}}
 */
function requireSession_(token, needAdmin) {
  const fail = function () { return appError_('unauthorized', 'ログインし直してください。'); };
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw fail();
  const cache = CacheService.getScriptCache();
  const raw = cache.get(sessionKey_(token));
  if (!raw) throw fail();
  let sess;
  try { sess = JSON.parse(raw); } catch (e) { throw fail(); }
  // スタッフは控えから確かめる（v0.18.0。呼び出しのたびにスタッフのシートを読まない）
  const ref = staffRef_(sess.id);
  if (!ref || !ref.enabled || ref.stamp !== sess.stamp) {
    cache.remove(sessionKey_(token));
    throw fail();
  }
  // 使っている間は切れないように、1時間たっていたら有効時間を延ばす
  if (Date.now() - Number(sess.at || 0) > 3600 * 1000) {
    // 延ばす時は、シートで確かめ直す（控えが古くても、無効・パスワード変更のまま延ばさない）
    const staff = findStaff_(sess.id);
    if (!staff || staff['有効'] !== YES || passwordStamp_(staff['パスワードハッシュ']) !== sess.stamp) {
      cache.remove(sessionKey_(token));
      throw fail();
    }
    putSession_(token, staff, Date.now());
  }
  const role = ref.role;
  if (needAdmin && role !== ROLE_ADMIN) throw appError_('forbidden', 'この操作は管理者だけができます。');
  return { id: ref.id, name: ref.name, role: role, isAdmin: role === ROLE_ADMIN, startView: ref.start };
}

/** スタッフが自分で選んだ「開いた直後の画面」。選んでいない・決めた値でない時は空 */
function staffStartView_(staff) {
  const v = String(staff['開始画面'] === undefined ? '' : staff['開始画面']).trim();
  return START_VIEWS.indexOf(v) !== -1 ? v : '';
}

// ---------------------------------------------------------------------------
// ログインしたままにする（端末が覚える合言葉）
// ---------------------------------------------------------------------------
const REMEMBER_PREFIX = 'rem_';

function isHex64_(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** プロパティのキー。合言葉そのものは持たない（ハッシュだけ） */
function rememberKey_(secret) {
  return REMEMBER_PREFIX + sha256Hex_('remember:' + secret);
}

function rememberParse_(raw) {
  let r = null;
  try { r = JSON.parse(String(raw || '')); } catch (e) { r = null; }
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.stamp !== 'string' || !(Number(r.exp) > 0)) return null;
  return { id: r.id, exp: Number(r.exp), stamp: r.stamp };
}

/**
 * 合言葉を新しく出す。ついでに、期限が切れたもの・多すぎるものを片づける。
 * @return {string} 合言葉（端末に渡す。サーバーには残さない）
 */
function issueRemember_(staff) {
  const props = PropertiesService.getScriptProperties();
  const id = normStaffId_(staff['スタッフID']);
  const now = Date.now();
  try {
    const all = props.getProperties();
    const live = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(REMEMBER_PREFIX) !== 0) return;
      const r = rememberParse_(all[k]);
      if (!r || r.exp <= now) { props.deleteProperty(k); return; }
      live.push({ key: k, id: r.id, exp: r.exp });
    });
    live.sort(function (a, b) { return b.exp - a.exp; });      // 新しい順
    const mine = live.filter(function (x) { return x.id === id; });
    const drop = {};
    mine.slice(REMEMBER_MAX_PER_STAFF - 1).forEach(function (x) { drop[x.key] = true; });
    live.filter(function (x) { return !drop[x.key]; }).slice(REMEMBER_MAX_TOTAL - 1).forEach(function (x) { drop[x.key] = true; });
    Object.keys(drop).forEach(function (k) { props.deleteProperty(k); });
  } catch (e) {
    console.warn('古い「ログインしたまま」の片づけに失敗しました: ' + e);
  }
  const secret = newToken_();
  props.setProperty(rememberKey_(secret), JSON.stringify({
    id: id, exp: now + REMEMBER_DAYS * 86400000, stamp: passwordStamp_(staff['パスワードハッシュ'])
  }));
  return secret;
}

/** 合言葉を使えなくする（ログアウト） */
function dropRemember_(secret) {
  if (!isHex64_(secret)) return;
  try { PropertiesService.getScriptProperties().deleteProperty(rememberKey_(secret)); } catch (e) { /* 期限で切れる */ }
}

/** そのスタッフの合言葉を全部使えなくする。keep を渡すと、その合言葉だけは新しいパスワードに合わせて残す */
function dropRemembersOf_(staffId, keep, newHash) {
  try {
    const props = PropertiesService.getScriptProperties();
    const id = normStaffId_(staffId);
    const keepKey = isHex64_(keep) ? rememberKey_(keep) : '';
    const all = props.getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(REMEMBER_PREFIX) !== 0) return;
      const r = rememberParse_(all[k]);
      if (r && r.id !== id) return;
      if (r && k === keepKey && r.exp > Date.now()) {
        props.setProperty(k, JSON.stringify({ id: r.id, exp: r.exp, stamp: passwordStamp_(newHash) }));
        return;
      }
      props.deleteProperty(k);
    });
  } catch (e) {
    // 残っても、パスワードの印が合わないので使えない
    console.warn('「ログインしたまま」の取り消しに失敗しました: ' + e);
  }
}

/** セッションを作って、最初の画面のデータと一緒に返す（login と loginWithRemember で同じ） */
function openSession_(staff, withRest, longTicket) {
  const id = normStaffId_(staff['スタッフID']);
  const token = newToken_();
  putSession_(token, staff, Date.now());
  // 最終ログインは記録だけ。書けなくても（他の保存と重なった）ログインは通す（v0.19.0）
  // 同じ日に何度もログインする時は書かない（v0.20.0。書くとロック・シートへの書き込み・控えの作り直しで遅くなる）
  if (String(staff['最終ログイン'] || '').slice(0, 10) !== todayYmd_()) try {
    withLock_(function () {
      const fresh = findStaff_(id);
      if (fresh) updateRecord_(SHEET_STAFF, fresh._row, { '最終ログイン': nowStamp_() });
    });
  } catch (e) {
    if (!(e && e.appCode === 'busy')) throw e;
    console.warn('最終ログインを書けませんでした（他の保存と重なった）');
  }
  const role = staff['権限'] === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF;
  const me = { id: id, name: staff['表示名'] || id, role: role, isAdmin: role === ROLE_ADMIN, startView: staffStartView_(staff), lastLogin: String(staff['最終ログイン'] || '') };
  // 最初の画面に要るデータも一緒に返す（ログインの後にもう1往復しないで済むように）
  const out = { token: token, me: me, boot: bootCore_(me), resume: issueResume_(token, { id: id, stamp: passwordStamp_(staff['パスワードハッシュ']) }, longTicket === true) };
  // パソコンは、残りのデータも同じ返事で渡す（もう1往復しないで済むように。v0.20.0）
  if (withRest === true) { const rest = bootRestIfWarm_(me); if (rest) out.rest = rest; }
  return out;
}

// ---------------------------------------------------------------------------
// 読み直してもログインしたまま（v0.19.0）
//   GAS の画面は Google の枠（別のドメイン）の中で動くので、ブラウザの設定によっては、
//   画面の中の保存（sessionStorage・localStorage）が使えず、読み直すとログアウトしてしまう。
//   そこで「読み直し用の券」を、ページのURLの # の後に入れておく（サーバーには送られない部分）。
//   開いているあいだは画面が20分ごとに新しい券に替える（renewResume）。使うたびにも替わる（前の券は2分で使えなくなる）。
//   ログアウト・パスワードの変更・無効化で、券も使えなくなる。
//
//   v0.28.0：券を「控え（CacheService）」だけでなく、スクリプトのプロパティにも残すようにした。
//     控えは、混んでくると Google が勝手に消すことがあり、そのとき読み直すとログアウトしていた。
//     また、パソコンがスリープして20分ごとの更新が止まると、30分で切れてログアウトしていた。
//     プロパティの券は RESUME_KEEP_HOURS 時間（12時間）使える。控えに無くても、こちらでログインを戻す（新しいセッションを作る）。
//     URLをうっかり人に送ると、その間は使えてしまうので、送らないこと（ログアウトすれば、その券はすぐ使えなくなる）。
// ---------------------------------------------------------------------------
const RESUME_GRACE_SECONDS = 120;
const RESUME_SECONDS = 1800;
const RESUME_KEEP_HOURS = 12;
const RESUME_PROP_PREFIX = 'rsp_';
const RESUME_PROP_MAX = 400;          // 全員ぶんの上限（超えたら古いものから消す）
function resumeKey_(ticket) { return 'rs_' + sha256Hex_(ticket).slice(0, 40); }
function resumePropKey_(ticket) { return RESUME_PROP_PREFIX + sha256Hex_('resume:' + ticket).slice(0, 40); }
function resumeParse_(raw) {
  let r = null;
  try { r = JSON.parse(String(raw || '')); } catch (e) { r = null; }
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.stamp !== 'string' || !(Number(r.exp) > 0)) return null;
  return { id: r.id, stamp: r.stamp, exp: Number(r.exp), long: r.long === 1 };
}
/** 期限の切れた券・多すぎる券を片づける */
function tidyResumeProps_(props) {
  try {
    const all = props.getProperties(), now = Date.now(), live = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(RESUME_PROP_PREFIX) !== 0) return;
      const r = resumeParse_(all[k]);
      if (!r || r.exp <= now) { props.deleteProperty(k); return; }
      live.push({ key: k, exp: r.exp });
    });
    live.sort(function (a, b) { return b.exp - a.exp; }).slice(RESUME_PROP_MAX - 1).forEach(function (x) { props.deleteProperty(x.key); });
  } catch (e) { console.warn('古い読み直し用の券の片づけに失敗しました: ' + e); }
}
/**
 * 券を出す。token のセッションの本人（id・パスワードの印）も、プロパティに残す。
 * @param {string} token
 * @param {{id:string, stamp:string}=} who 分かっていれば渡す（無ければ控えのセッションから読む）
 */
/*
 * v0.106.0：「ログインしたまま」の端末では、券を REMEMBER_DAYS 日使えるようにする（long）。
 *   iPhone の Safari は、Google の枠の中の保存（localStorage）とクッキーを、閉じた時や数日で消すことがある。
 *   そのとき残るのは、ページのURLの券だけ。12時間で切れると、翌日に開くとログアウトしていた。
 *   券は使うたび・20分ごとに替わり、前の券は2分で使えなくなるので、長くしても、古いURLは使えない。
 */
function issueResume_(token, who, long) {
  try {
    const cache = CacheService.getScriptCache();
    const ticket = newToken_();
    cache.put(resumeKey_(ticket), token, RESUME_SECONDS);
    if (!who) { try { who = JSON.parse(cache.get(sessionKey_(token)) || 'null'); } catch (e) { who = null; } }
    if (who && who.id) {
      const props = PropertiesService.getScriptProperties();
      if (Math.random() < 0.2) tidyResumeProps_(props);
      props.setProperty(resumePropKey_(ticket), JSON.stringify({ id: String(who.id), stamp: String(who.stamp || ''), exp: Date.now() + (long ? REMEMBER_DAYS * 86400000 : RESUME_KEEP_HOURS * 3600000), long: long ? 1 : 0 }));
    }
    return ticket;
  } catch (e) {
    console.warn('読み直し用の券を出せませんでした: ' + e);
    return '';
  }
}
/** 券を使えなくする（ログアウト・使い終わり） */
function dropResume_(ticket) {
  if (!isHex64_(ticket)) return;
  try { CacheService.getScriptCache().remove(resumeKey_(ticket)); } catch (e) { /* 期限で切れる */ }
  try { PropertiesService.getScriptProperties().deleteProperty(resumePropKey_(ticket)); } catch (e) { /* 期限で切れる */ }
}

// ---------------------------------------------------------------------------
// 公開関数
// ---------------------------------------------------------------------------
/**
 * ログイン。remember が true なら、この端末でログインしたままにするための合言葉も返す。
 * @param {{staffId:string, password:string, remember:boolean=}} params
 * @return {{ok:boolean, token:string, me:Object, remember:string=}}
 */
function login(params) {
  const tStart = Date.now();
  return apiPack_(params, function () {
    const p = params || {};
    const id = normStaffId_(p.staffId);
    const pw = typeof p.password === 'string' ? p.password : '';
    const wrong = function () { return appError_('login', 'スタッフIDかパスワードが違います。'); };
    if (!id || !pw) throw appError_('invalid', 'スタッフIDとパスワードを入れてください。');
    if (!isValidStaffId_(id) || pw.length > 200) throw wrong();

    const cache = CacheService.getScriptCache();
    const failKey = 'fail_' + id;
    const fails = Number(cache.get(failKey)) || 0;
    if (fails >= LOGIN_MAX_FAILS) {
      throw appError_('locked', '間違いが続いたので、しばらくログインできません。' + Math.round(LOGIN_LOCK_SECONDS / 60) + '分ほど待ってください。');
    }

    const staff = findStaff_(id);
    // IDが無いときも同じだけ計算して、応答の速さでIDの有無が分からないようにする
    const stored = staff ? staff['パスワードハッシュ'] : 'v1$' + PASSWORD_HASH_ROUNDS + '$0000000000000000$' + new Array(65).join('0');
    const ok = verifyPassword_(pw, stored) && !!staff && staff['有効'] === YES;
    if (!ok) {
      cache.put(failKey, String(fails + 1), LOGIN_LOCK_SECONDS);
      throw wrong();
    }
    cache.remove(failKey);

    const out = openSession_(staff, p.withRest === true, p.remember === true);
    if (p.remember === true) {
      // この端末が前に持っていた合言葉は、新しいものと入れ替える（ログインし直すたびに、端末の枠が減っていかないように。v0.91.0）
      if (isHex64_(p.prevRemember)) {
        try {
          const pk = rememberKey_(p.prevRemember), pr = rememberParse_(PropertiesService.getScriptProperties().getProperty(pk));
          if (pr && pr.id === id) PropertiesService.getScriptProperties().deleteProperty(pk);
        } catch (e) { console.warn('前の合言葉を消せませんでした: ' + e); }
      }
      // 合言葉を保存できなくても（プロパティの一時的なエラーなど）、ログインは通す
      try {
        out.remember = issueRemember_(staff);
        out.rememberDays = REMEMBER_DAYS;
      } catch (e) {
        console.warn('「ログインしたまま」を保存できませんでした: ' + e);
        out.rememberFailed = true;
      }
    }
    out.srvMs = Date.now() - tStart;      // サーバーで使った時間（画面の下に出す。v0.88.0）
    return out;
  });
}

/**
 * 「ログインしたままにする」を選んだ端末からの、自動ログイン。
 * 合言葉が合っていて、期限の中で、スタッフが有効で、パスワードが変わっていなければ、新しいセッションを出す。
 * @param {{remember:string}} params
 * @return {{ok:boolean, token:string, me:Object}}
 */
function loginWithRemember(params) {
  return apiPack_(params, function () {
    const secret = params && params.remember;
    // 画面に出す理由も分けておく（どれで切れたか、後で分かるように。v0.92.0）
    const fail = function (why) { return appError_('unauthorized', why || 'ログインし直してください。'); };
    if (!isHex64_(secret)) throw fail();
    const props = PropertiesService.getScriptProperties();
    const key = rememberKey_(secret);
    const raw = props.getProperty(key);
    if (!raw) throw fail('この端末の「ログインしたまま」が、サーバーに残っていません（他の端末で6台以上ログインした・ログアウトした・長く使わなかった、のどれか）。');
    const r = rememberParse_(raw);
    if (!r || r.exp <= Date.now()) { props.deleteProperty(key); throw fail('「ログインしたまま」の期限（' + REMEMBER_DAYS + '日）が切れました。'); }
    const staff = findStaff_(r.id);
    if (!staff || staff['有効'] !== YES) { props.deleteProperty(key); throw fail('このスタッフは、今使えない設定になっています。'); }
    if (passwordStamp_(staff['パスワードハッシュ']) !== r.stamp) { props.deleteProperty(key); throw fail('パスワードが変わったので、「ログインしたまま」が切れました。'); }
    const out = openSession_(staff, !!(params && params.withRest === true), true);
    // 使うたびに期限を延ばす（最後に使った日から REMEMBER_DAYS 日。毎日使う端末が、30日めに切れないように。v0.91.0）
    let exp = r.exp;
    const now = Date.now();
    if (exp - now < (REMEMBER_DAYS - 1) * 86400000) {
      try {
        exp = now + REMEMBER_DAYS * 86400000;
        props.setProperty(key, JSON.stringify({ id: r.id, exp: exp, stamp: r.stamp }));
      } catch (e) {
        exp = r.exp;
        console.warn('「ログインしたまま」の期限を延ばせませんでした: ' + e);
      }
    }
    out.rememberUntil = Utilities.formatDate(new Date(exp), scriptTz_(), 'yyyy-MM-dd');
    return out;
  });
}

/**
 * 自分の「開いた直後の画面」を変える。空にすると、全体の設定に合わせる。
 * @param {{token:string, startView:string}} params
 */
function saveMyStartView(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const v = typeof p.startView === 'string' ? p.startView.trim() : '';
    if (v && START_VIEWS.indexOf(v) === -1) throw appError_('invalid', '開いた直後の画面は「' + START_VIEWS.join('」「') + '」から選んでください。');
    withLock_(function () {
      const staff = findStaff_(me.id);
      if (!staff) throw appError_('unauthorized', 'ログインし直してください。');
      if (readTable_(SHEET_STAFF).headers.indexOf('開始画面') === -1) {
        throw appError_('setup', 'スタッフのシートに「開始画面」の列がありません。スプレッドシートのメニューから「初期設定」をもう一度実行してください。');
      }
      updateRecord_(SHEET_STAFF, staff._row, { '開始画面': v, '更新日時': nowStamp_() });
    });
    return { startView: v };
  });
}

/**
 * 画面の状態（絞り込み・並び替え・期間の種類）を、決めた形だけにする。形が違うところは捨てる。
 * @return {{q:Object, sort:Object, per:Object}}
 */
function cleanViewState_(input) {
  const out = { q: {}, sort: {}, per: {} };
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const own = function (o) { return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []; };
  own(src.q).slice(0, 80).forEach(function (k) {
    const v = src.q[k];
    if (!/^[a-z]{2,12}\.[A-Za-z]{2,16}$/.test(k) || typeof v !== 'string' || v.length > 100) return;
    out.q[k] = v;
  });
  own(src.sort).slice(0, 40).forEach(function (k) {
    const v = src.sort[k];
    if (!/^[A-Za-z]{2,20}$/.test(k) || !v || typeof v !== 'object') return;
    const i = Number(v.i), dir = Number(v.dir);
    if (i !== Math.floor(i) || i < 0 || i > 40 || (dir !== 1 && dir !== -1)) return;
    out.sort[k] = { i: i, dir: dir };
  });
  own(src.per).slice(0, 10).forEach(function (k) {
    const v = src.per[k];
    if (!/^[a-z]{2,12}$/.test(k) || !v || typeof v !== 'object' || VIEW_PERIOD_MODES.indexOf(v.mode) === -1) return;
    out.per[k] = { mode: v.mode };
  });
  return out;
}

/** スタッフの行から、覚えてある画面の状態を取り出す（無い・壊れている時は空） */
function staffViewState_(staff) {
  let parsed = null;
  try { parsed = JSON.parse(String((staff && staff['画面設定']) || '')); } catch (e) { parsed = null; }
  return cleanViewState_(parsed);
}

/**
 * 自分の画面の状態（絞り込み・並び替え・期間の種類）を覚える。次に開いた時、どの端末でも同じ状態で始まる。
 * @param {{token:string, view:{q:Object, sort:Object, per:Object}}} params
 */
function saveMyView(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const view = cleanViewState_(p.view);
    const json = JSON.stringify(view);
    if (json.length > VIEW_STATE_MAX_CHARS) throw appError_('invalid', '覚えておく絞り込みが多すぎます。');
    withLock_(function () {
      const head = tableHead_(SHEET_STAFF);
      if (head.headers.indexOf('画面設定') === -1) {
        throw appError_('setup', 'スタッフのシートに「画面設定」の列がありません。スプレッドシートのメニューから「初期設定」をもう一度実行してください。');
      }
      const staff = findStaff_(me.id);
      if (!staff) throw appError_('unauthorized', 'ログインし直してください。');
      updateRecord_(SHEET_STAFF, staff._row, { '画面設定': json });
    });
    return { view: view };
  });
}

/**
 * ログアウト。この端末の「ログインしたまま」も取り消す。
 * @param {{token:string, remember:string=}} params
 */
/**
 * 読み直したとき：URLの券から、ログインを戻す。最初の画面のデータと、新しい券も返す。
 * @param {{ticket:string}} params
 */
function resumeSession(params) {
  return apiPack_(params, function () {
    const ticket = params && params.ticket;
    const fail = function () { return appError_('unauthorized', 'ログインし直してください。'); };
    if (!isHex64_(ticket)) throw fail();
    const cache = CacheService.getScriptCache();
    const key = resumeKey_(ticket);
    const token = cache.get(key);
    let me = null;
    if (isHex64_(token)) { try { me = requireSession_(token); } catch (e) { me = null; } }
    const keep = params.keep === true;      // この端末は「ログインしたまま」（長い券を出す）
    if (me) {
      cache.put(key, token, RESUME_GRACE_SECONDS); // 前の券は、すぐには消さない（2つのタブで同時に読み直したとき用）
      let wasLong = false;
      try {
        const pp = PropertiesService.getScriptProperties(), pkk = resumePropKey_(ticket), old = resumeParse_(pp.getProperty(pkk));
        wasLong = !!(old && old.long);
        pp.deleteProperty(pkk);
      } catch (e) { /* 期限で切れる */ }
      const out = { token: token, me: me, boot: bootCore_(me), resume: issueResume_(token, null, keep || wasLong) };
      if (params.withRest === true) { const rest = bootRestIfWarm_(me); if (rest) out.rest = rest; }
      return out;
    }
    // 控えに無い・セッションが切れていた：プロパティの券で、ログインし直す（v0.28.0）
    const props = PropertiesService.getScriptProperties();
    const pk = resumePropKey_(ticket);
    const r = resumeParse_(props.getProperty(pk));
    if (!r || r.exp <= Date.now()) { if (r) props.deleteProperty(pk); throw fail(); }
    const staff = findStaff_(r.id);
    if (!staff || staff['有効'] !== YES || passwordStamp_(staff['パスワードハッシュ']) !== r.stamp) { props.deleteProperty(pk); throw fail(); }
    props.deleteProperty(pk);                      // 使った券は使えなくする（新しい券を返す）
    return openSession_(staff, params.withRest === true, keep || r.long);
  });
}

/**
 * 読み直し用の券を新しくする（画面が開いているあいだ、20分ごとに呼ぶ）。前の券は2分で使えなくなる。
 * @param {{token:string, ticket:string=}} params
 */
function renewResume(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    if (isHex64_(p.ticket)) {
      const cache = CacheService.getScriptCache();
      const key = resumeKey_(p.ticket);
      if (cache.get(key) === p.token) cache.put(key, p.token, RESUME_GRACE_SECONDS);
      try { PropertiesService.getScriptProperties().deleteProperty(resumePropKey_(p.ticket)); } catch (e) { /* 期限で切れる */ }
    }
    return { resume: issueResume_(p.token, null, p.keep === true) };
  });
}

function logout(params) {
  return api_(function () {
    const token = params && params.token;
    if (isHex64_(token)) CacheService.getScriptCache().remove(sessionKey_(token));
    dropRemember_(params && params.remember);
    dropResume_(params && params.ticket);
    return {};
  });
}

/**
 * 自分のパスワードを変える。
 * 他の端末の「ログインしたまま」は切れる。remember を渡すと、この端末のぶんだけは続けて使える。
 * @param {{token:string, current:string, next:string, remember:string=}} params
 */
function changeMyPassword(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    checkNewPassword_(p.next);
    withLock_(function () {
      const staff = findStaff_(me.id);
      if (!staff || !verifyPassword_(typeof p.current === 'string' ? p.current : '', staff['パスワードハッシュ'])) {
        throw appError_('invalid', '今のパスワードが違います。');
      }
      const hash = makePasswordHash_(p.next);
      updateRecord_(SHEET_STAFF, staff._row, { 'パスワードハッシュ': hash, '更新日時': nowStamp_() });
      logAudit_('パスワード変更', me.id, '', 'パスワード', '', '（本人が変更）', me.name);
      clearTempPassword_(me.id, hash);
      // このセッションだけは続けて使えるようにする（他の端末のセッションは切れる）
      staff['パスワードハッシュ'] = hash;
      putSession_(p.token, staff, Date.now());
      dropRemembersOf_(me.id, p.remember, hash);
    });
    // この端末の読み直し用の券も、新しいパスワードに合わせて出し直す（v0.28.0。古い券は印が合わず使えないため）
    if (isHex64_(p.ticket)) dropResume_(p.ticket);
    return { resume: issueResume_(p.token, null, p.keep === true) };
  });
}

/** スタッフの一覧（管理者）。@param {{token:string}} params */
function listStaff(params) {
  return api_(function () {
    requireSession_(params && params.token, true);
    return { staff: readTable_(SHEET_STAFF).rows.map(staffPublic_) };
  });
}

/**
 * スタッフの追加・変更（管理者）。追加の時は仮パスワードを1回だけ返す。
 * @param {{token:string, isNew:boolean, data:{スタッフID:string, 表示名:string, 権限:string, 有効:string}}} params
 */
function saveStaff(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const d = p.data || {};
    const id = normStaffId_(d['スタッフID']);
    const name = cleanText_(d['表示名'], 60);
    const role = String(d['権限'] || '');
    const active = String(d['有効'] || '');
    if (!isValidStaffId_(id)) throw appError_('invalid', 'スタッフIDは、半角の英数字と . _ - @ + で、3〜64文字にしてください（メールアドレスも使えます。頭は英数字）。');
    if (!name) throw appError_('invalid', '表示名を入れてください。');
    if (ROLES.indexOf(role) === -1) throw appError_('invalid', '権限を選んでください。');
    if (active !== YES && active !== NO) throw appError_('invalid', '有効・無効を選んでください。');

    return withLock_(function () {
      const existing = findStaff_(id);
      const now = nowStamp_();
      // 表示名が同じスタッフは作らない（写真の「付けた本人」を表示名で見分けているため。v0.19.0）
      const nameChanged = !existing || String(existing['表示名'] || '').trim() !== name;    // 前から同じ名前の人がいるデータでも、名前を変えない編集は通す
      const sameName = nameChanged && readTable_(SHEET_STAFF).rows.some(function (r) {
        return String(r['表示名'] || r['スタッフID']).trim() === name && normStaffId_(r['スタッフID']) !== id;
      });
      if (sameName) throw appError_('invalid', '同じ表示名のスタッフがいます。「山田（本社）」のように、ちがう名前にしてください。');
      if (p.isNew) {
        if (existing) throw appError_('invalid', 'そのスタッフIDはすでに使われています。');
        const tempPassword = randomPassword_(10);
        const tempHash = makePasswordHash_(tempPassword);
        appendRecord_(SHEET_STAFF, {
          'スタッフID': id, '表示名': name, 'パスワードハッシュ': tempHash,
          '権限': role, '有効': active, '登録日時': now, '更新日時': now
        });
        markTempPassword_(id, tempHash);
        logAudit_('スタッフ追加', id, '', '', '', name + '（' + role + '）', me.name);
        return { staff: staffPublic_(findStaff_(id)), tempPassword: tempPassword };
      }
      if (!existing) throw appError_('notfound', 'そのスタッフが見つかりません。');
      if (id === me.id && (role !== ROLE_ADMIN || active !== YES)) {
        throw appError_('invalid', '自分自身を無効にしたり、管理者から外したりはできません。');
      }
      const otherAdmins = readTable_(SHEET_STAFF).rows.filter(function (r) {
        return normStaffId_(r['スタッフID']) !== id && r['権限'] === ROLE_ADMIN && r['有効'] === YES;
      }).length;
      if (otherAdmins === 0 && (role !== ROLE_ADMIN || active !== YES)) {
        throw appError_('invalid', '有効な管理者が1人もいなくなるので、変更できません。');
      }
      const before = existing['表示名'] + '（' + existing['権限'] + '・有効:' + existing['有効'] + '）';
      updateRecord_(SHEET_STAFF, existing._row, { '表示名': name, '権限': role, '有効': active, '更新日時': now });
      logAudit_('スタッフ変更', id, '', '', before, name + '（' + role + '・有効:' + active + '）', me.name);
      if (active !== YES) dropRemembersOf_(id, '', '');     // 無効にした人の「ログインしたまま」を切る
      return { staff: staffPublic_(findStaff_(id)) };
    });
  });
}

/**
 * スタッフのパスワードを仮パスワードに戻す（管理者）。仮パスワードを1回だけ返す。
 * @param {{token:string, staffId:string, remember:string=}} params
 */
function resetStaffPassword(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const staff = findStaff_(p.staffId);
      if (!staff) throw appError_('notfound', 'そのスタッフが見つかりません。');
      const tempPassword = randomPassword_(10);
      const hash = makePasswordHash_(tempPassword);
      updateRecord_(SHEET_STAFF, staff._row, { 'パスワードハッシュ': hash, '更新日時': nowStamp_() });
      markTempPassword_(staff['スタッフID'], hash);
      // 連続間違いで止まっていたら、解除する（渡した仮パスワードで、すぐ入れるように）
      CacheService.getScriptCache().remove('fail_' + normStaffId_(staff['スタッフID']));
      logAudit_('パスワード再設定', staff['スタッフID'], '', 'パスワード', '', '（管理者が再設定）', me.name);
      const self = normStaffId_(staff['スタッフID']) === me.id;
      if (self) {
        staff['パスワードハッシュ'] = hash;
        putSession_(p.token, staff, Date.now());
      }
      // その人の「ログインしたまま」は全部切る（自分の時は、この端末のぶんだけ残す）
      dropRemembersOf_(staff['スタッフID'], self ? p.remember : '', hash);
      return { tempPassword: tempPassword };
    });
  });
}
