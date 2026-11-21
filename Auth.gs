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

function hashPassword_(password, salt, rounds) {
  let h = sha256Hex_(salt + ':' + password);
  for (let i = 0; i < rounds; i++) h = sha256Hex_(h + ':' + salt);
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

/** 読みまちがえにくい文字だけの仮パスワード */
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
    // 延ばすときは、シートで確かめ直す（控えが古くても、無効・パスワード変更のまま延ばさない）
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

/** スタッフが自分で選んだ「開いた直後の画面」。選んでいない・決めた値でないときは空 */
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
function openSession_(staff, withRest) {
  const id = normStaffId_(staff['スタッフID']);
  const token = newToken_();
  putSession_(token, staff, Date.now());
  // 最終ログインは記録だけ。書けなくても（ほかの保存と重なった）ログインは通す（v0.19.0）
  // 同じ日に何度もログインするときは書かない（v0.20.0。書くとロック・シートへの書き込み・控えの作り直しで遅くなる）
  if (String(staff['最終ログイン'] || '').slice(0, 10) !== todayYmd_()) try {
    withLock_(function () {
      const fresh = findStaff_(id);
      if (fresh) updateRecord_(SHEET_STAFF, fresh._row, { '最終ログイン': nowStamp_() });
    });
  } catch (e) {
    if (!(e && e.appCode === 'busy')) throw e;
    console.warn('最終ログインを書けませんでした（ほかの保存と重なった）');
  }
  const role = staff['権限'] === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF;
  const me = { id: id, name: staff['表示名'] || id, role: role, isAdmin: role === ROLE_ADMIN, startView: staffStartView_(staff) };
  // 最初の画面に要るデータも一緒に返す（ログインのあとにもう1往復しないで済むように）
  const out = { token: token, me: me, boot: bootCore_(me), resume: issueResume_(token, { id: id, stamp: passwordStamp_(staff['パスワードハッシュ']) }) };
  // パソコンは、残りのデータも同じ返事で渡す（もう1往復しないで済むように。v0.20.0）
  if (withRest === true) { const rest = bootRestIfWarm_(me); if (rest) out.rest = rest; }
  return out;
}

// ---------------------------------------------------------------------------
// 読み直してもログインしたまま（v0.19.0）
//   GAS の画面は Google の枠（別のドメイン）の中で動くので、ブラウザの設定によっては、
//   画面の中の保存（sessionStorage・localStorage）が使えず、読み直すとログアウトしてしまう。
//   そこで「読み直し用の券」を、ページのURLの # のあとに入れておく（サーバーには送られない部分）。
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
  return { id: r.id, stamp: r.stamp, exp: Number(r.exp) };
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
function issueResume_(token, who) {
  try {
    const cache = CacheService.getScriptCache();
    const ticket = newToken_();
    cache.put(resumeKey_(ticket), token, RESUME_SECONDS);
    if (!who) { try { who = JSON.parse(cache.get(sessionKey_(token)) || 'null'); } catch (e) { who = null; } }
    if (who && who.id) {
      const props = PropertiesService.getScriptProperties();
      if (Math.random() < 0.2) tidyResumeProps_(props);
      props.setProperty(resumePropKey_(ticket), JSON.stringify({ id: String(who.id), stamp: String(who.stamp || ''), exp: Date.now() + RESUME_KEEP_HOURS * 3600000 }));
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
  return api_(function () {
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
      throw appError_('locked', 'まちがいが続いたので、しばらくログインできません。' + Math.round(LOGIN_LOCK_SECONDS / 60) + '分ほど待ってください。');
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

    const out = openSession_(staff, p.withRest === true);
    if (p.remember === true) {
      // 合言葉を保存できなくても（プロパティの一時的なエラーなど）、ログインは通す
      try {
        out.remember = issueRemember_(staff);
        out.rememberDays = REMEMBER_DAYS;
      } catch (e) {
        console.warn('「ログインしたまま」を保存できませんでした: ' + e);
        out.rememberFailed = true;
      }
    }
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
  return api_(function () {
    const secret = params && params.remember;
    const fail = function () { return appError_('unauthorized', 'ログインし直してください。'); };
    if (!isHex64_(secret)) throw fail();
    const props = PropertiesService.getScriptProperties();
    const key = rememberKey_(secret);
    const raw = props.getProperty(key);
    if (!raw) throw fail();
    const r = rememberParse_(raw);
    const staff = r && r.exp > Date.now() ? findStaff_(r.id) : null;
    if (!staff || staff['有効'] !== YES || passwordStamp_(staff['パスワードハッシュ']) !== r.stamp) {
      props.deleteProperty(key);
      throw fail();
    }
    const out = openSession_(staff, !!(params && params.withRest === true));
    out.rememberUntil = Utilities.formatDate(new Date(r.exp), scriptTz_(), 'yyyy-MM-dd');
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

/** スタッフの行から、覚えてある画面の状態を取り出す（無い・壊れているときは空） */
function staffViewState_(staff) {
  let parsed = null;
  try { parsed = JSON.parse(String((staff && staff['画面設定']) || '')); } catch (e) { parsed = null; }
  return cleanViewState_(parsed);
}

/**
 * 自分の画面の状態（絞り込み・並び替え・期間の種類）を覚える。次に開いたとき、どの端末でも同じ状態で始まる。
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
 * 読み直したとき：URLの券から、ログインを戻す。最初の画面のデータと、新しい券も返す。
 * @param {{ticket:string}} params
 */
function resumeSession(params) {
  return api_(function () {
    const ticket = params && params.ticket;
    const fail = function () { return appError_('unauthorized', 'ログインし直してください。'); };
    if (!isHex64_(ticket)) throw fail();
    const cache = CacheService.getScriptCache();
    const key = resumeKey_(ticket);
    const token = cache.get(key);
    let me = null;
    if (isHex64_(token)) { try { me = requireSession_(token); } catch (e) { me = null; } }
    if (me) {
      cache.put(key, token, RESUME_GRACE_SECONDS); // 前の券は、すぐには消さない（2つのタブで同時に読み直したとき用）
      try { PropertiesService.getScriptProperties().deleteProperty(resumePropKey_(ticket)); } catch (e) { /* 期限で切れる */ }
      const out = { token: token, me: me, boot: bootCore_(me), resume: issueResume_(token) };
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
    return openSession_(staff, params.withRest === true);
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
    return { resume: issueResume_(p.token) };
  });
}

/**
 * ログアウト。この端末の「ログインしたまま」と、読み直し用の券も取り消す。
 * @param {{token:string, remember:string=, ticket:string=}} params
 */
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
 * ほかの端末の「ログインしたまま」は切れる。remember を渡すと、この端末のぶんだけは続けて使える。
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
      // このセッションだけは続けて使えるようにする（ほかの端末のセッションは切れる）
      staff['パスワードハッシュ'] = hash;
      putSession_(p.token, staff, Date.now());
      dropRemembersOf_(me.id, p.remember, hash);
    });
    // この端末の読み直し用の券も、新しいパスワードに合わせて出し直す（v0.28.0。古い券は印が合わず使えないため）
    if (isHex64_(p.ticket)) dropResume_(p.ticket);
    return { resume: issueResume_(p.token) };
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
 * スタッフの追加・変更（管理者）。追加のときは仮パスワードを1回だけ返す。
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
        appendRecord_(SHEET_STAFF, {
          'スタッフID': id, '表示名': name, 'パスワードハッシュ': makePasswordHash_(tempPassword),
          '権限': role, '有効': active, '登録日時': now, '更新日時': now
        });
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
      // 連続まちがいで止まっていたら、解除する（渡した仮パスワードで、すぐ入れるように）
      CacheService.getScriptCache().remove('fail_' + normStaffId_(staff['スタッフID']));
      logAudit_('パスワード再設定', staff['スタッフID'], '', 'パスワード', '', '（管理者が再設定）', me.name);
      const self = normStaffId_(staff['スタッフID']) === me.id;
      if (self) {
        staff['パスワードハッシュ'] = hash;
        putSession_(p.token, staff, Date.now());
      }
      // その人の「ログインしたまま」は全部切る（自分のときは、この端末のぶんだけ残す）
      dropRemembersOf_(staff['スタッフID'], self ? p.remember : '', hash);
      return { tempPassword: tempPassword };
    });
  });
}
