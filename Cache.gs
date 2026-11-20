/**
 * Cache.gs … 画面を開くときに渡すデータの「控え」（サーバー側のキャッシュ）
 *
 * 画面を開くたびにシートを全部読むと時間がかかるので、画面に渡す形にしたものを CacheService に控えておく。
 *
 * しくみ
 *   - 控えは「部品」ごと（顧客・機器・対応履歴・要対応…）。どの部品がどのシートから作られるかは Config.gs の CACHE_DEPS
 *   - シートごとに「版の印」を持つ。アプリがそのシートに書いたら、印を新しくする（Db.gs の withLock_ の終わり）
 *   - 部品の控えの頭には、作ったときの「もとのシートの印」を付けてある。読むときに、いまの印と違えば使わない
 *     （消し忘れが起きない。キーは部品ごとに決まっていて上書きになるので、古い控えが溜まらない）
 *   - スプレッドシートを手で直したときは onEdit が印を新しくする。行の削除などは onEdit が動かないので、
 *     そのときは最長で SERVER_CACHE_SECONDS のあいだ古いまま（画面の「最新を読み込む」で、すぐ読み直せる）
 *   - CacheService が使えない・値が大きすぎる、などのときは、何も言わずにシートを直接読む（遅くなるだけで、止まらない）
 *
 * 公開関数：onEdit（スプレッドシートを手で直したときに、Google が呼ぶ）
 */

const CACHE_GEN_ALL = 'gen_all';     // 全部の控えを使えなくするための印
const CACHE_GEN_SECONDS = 21600;

let cacheGens_ = null;               // この実行で最初に読んだ印（シートを読む前に取っておく）
let cacheStats_ = { hit: 0, miss: 0 };
let cacheFresh_ = false;             // この実行では控えを読まない（「最新を読み込む」。作ったものは控える）
let cacheWatched_ = null;
let cacheWarmOnly_ = false;          // 控えに無い部品があったら、作らずにやめる（ログインの返事に、残りのデータを付けるかどうか。v0.20.0）

function cacheOn_() {
  return SERVER_CACHE_SECONDS > 0;
}

/** 控えのもとになっているシートの名前 → 番号（キーに日本語を入れないため） */
function cacheWatchedSheets_() {
  if (cacheWatched_) return cacheWatched_;
  const map = {};
  Object.keys(CACHE_DEPS).forEach(function (part) {
    CACHE_DEPS[part].forEach(function (name) { map[name] = SHEET_ORDER.indexOf(name); });
  });
  cacheWatched_ = map;
  return map;
}

function cacheGenKey_(sheetName) {
  return 'gen_' + cacheWatchedSheets_()[sheetName];
}

function cacheNewGen_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

/**
 * いまの印をまとめて読む（1回の実行で1回だけ）。シートを読む前に呼ぶこと。
 * 先にシートを読んでから印を読むと、その間にほかの人が保存したとき、古い中身を新しい印で控えてしまう。
 * @return {Object|null} {キー: 印}。キャッシュが使えないときは null
 */
function cachePrime_() {
  if (!cacheOn_()) return null;
  if (cacheGens_) return cacheGens_;
  try {
    const cache = CacheService.getScriptCache();
    const keys = [CACHE_GEN_ALL].concat(Object.keys(cacheWatchedSheets_()).map(cacheGenKey_));
    const got = cache.getAll(keys) || {};
    const fresh = {};
    let missing = false;
    keys.forEach(function (k) {
      if (typeof got[k] === 'string' && got[k]) return;
      got[k] = fresh[k] = cacheNewGen_();
      missing = true;
    });
    if (missing) cache.putAll(fresh, CACHE_GEN_SECONDS);
    cacheGens_ = got;
  } catch (e) {
    console.warn('控えの印を読めませんでした: ' + e);
    cacheGens_ = null;
  }
  return cacheGens_;
}

/**
 * シートに書いたあとに呼ぶ。そのシートから作った控えを、使えなくする。
 * @param {Array<string>} sheetNames
 */
function cacheBump_(sheetNames) {
  cacheGens_ = null;
  if (!cacheOn_()) return;
  const watched = cacheWatchedSheets_();
  const map = {};
  let any = false;
  (sheetNames || []).forEach(function (name) {
    if (watched[name] === undefined) return;       // スタッフ・変更履歴など、控えに関係しないシート
    map[cacheGenKey_(name)] = cacheNewGen_();
    any = true;
  });
  if (!any) return;
  cachePutGens_(map);
}

/** 全部の控えを使えなくする（初期設定のあと・「最新を読み込む」）。自社名・ロゴ・Tips の控えも消す */
function cacheBumpAll_() {
  cacheGens_ = null;
  cacheDropSmall_();
  if (!cacheOn_()) return;
  const map = {};
  map[CACHE_GEN_ALL] = cacheNewGen_();
  cachePutGens_(map);
}

/** 自社名・ロゴ・Tips の控え（10分もの）を消す */
function cacheDropSmall_() {
  try { CacheService.getScriptCache().removeAll([BRAND_CACHE_KEY, TIPS_CACHE_KEY]); } catch (e) { /* 10分で切れる */ }
}

function cachePutGens_(map) {
  // 印を新しくできないと、古い控えが残る。1回だけやり直す
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      CacheService.getScriptCache().putAll(map, CACHE_GEN_SECONDS);
      return;
    } catch (e) {
      if (attempt === 1) console.warn('控えの印を新しくできませんでした: ' + e);
    }
  }
}

/** 部品の控えのキー（部品と、何個めか。印は値の頭に入れる） */
function cachePartKey_(part, i) {
  return 'pc_' + part + '_' + i;
}

/** 部品の控えのキーに入れる印（版・全体の印・もとのシートの印・日付など） */
function cachePartSig_(part, gens, extra) {
  const bits = [APP_VERSION, gens[CACHE_GEN_ALL]];
  CACHE_DEPS[part].forEach(function (name) { bits.push(gens[cacheGenKey_(name)]); });
  bits.push(extra || '');
  return sha256Hex_(bits.join('|')).slice(0, 20);
}

/**
 * 長い文字を、CacheService に入る大きさに切る（1つ100KBまで。日本語は1文字3バイトなので、文字数で余裕を見る）。
 * 絵文字（2つで1文字）の真ん中では切らない。
 * @return {Array<string>|null} 多すぎるときは null（控えない）
 */
function cacheSplit_(text) {
  const chunks = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + CACHE_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end--;
    }
    chunks.push(text.slice(at, end));
    at = end;
    if (chunks.length > CACHE_MAX_CHUNKS) return null;
  }
  if (!chunks.length) chunks.push('');
  chunks[0] = chunks.length + ':' + chunks[0];
  return chunks;
}

/**
 * 読んだ控えを、もとの値に戻す。どの切れ端も、頭に「印:」が付いている。
 * 印がいまのものと違う（＝もとのシートが変わった・別の実行が途中まで上書きした）・そろっていない・壊れているときは undefined
 */
function cacheJoin_(found, part, sig) {
  const head = sig + ':';
  const first = found[cachePartKey_(part, 0)];
  if (typeof first !== 'string' || first.indexOf(head) !== 0) return undefined;
  const m = /^(\d{1,2}):/.exec(first.slice(head.length, head.length + 4));
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 1 || n > CACHE_MAX_CHUNKS) return undefined;
  let text = first.slice(head.length + m[0].length);
  for (let i = 1; i < n; i++) {
    const piece = found[cachePartKey_(part, i)];
    if (typeof piece !== 'string' || piece.indexOf(head) !== 0) return undefined;
    text += piece.slice(head.length);
  }
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? undefined : value;
  } catch (e) {
    return undefined;
  }
}

/**
 * 部品をまとめて取る。控えがあればそれを、無ければシートから作って、控えておく。
 * 書き込みの途中（ロックの中）・書いた直後は、控えを使わない（必ずシートを読む）。
 * @param {Array<string>} parts CACHE_DEPS にある名前
 * @param {Object<string, function():*>} builders 部品を作る関数
 * @param {Object<string, string>=} extras 部品ごとに、キーに足す文字（日付など）
 * @return {Object<string, *>}
 */
function cachedParts_(parts, builders, extras, allowLock) {
  const out = {};
  const direct = function (part) { out[part] = builders[part](); };
  // この実行で書いたシートから作る部品だけ、控えを使わない（v0.20.0。前は、どれか1枚でも書いたら全部使わなかった）
  const touched = parts.some(function (part) { return (CACHE_DEPS[part] || []).some(function (name) { return dirtySheets_[name]; }); });
  const gens = ((lockDepth_ > 0 && !allowLock) || touched) ? null : cachePrime_();
  if (!gens) {
    parts.forEach(direct);
    return out;
  }
  const sigs = {};
  let found = {};
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const keys = [];
    parts.forEach(function (part) {
      sigs[part] = cachePartSig_(part, gens, extras && extras[part]);
      for (let i = 0; i < CACHE_MAX_CHUNKS; i++) keys.push(cachePartKey_(part, i));
    });
    // 「最新を読み込む」のときは、控えを読まずに作って、上書きする（印を新しくできなかったときでも、必ず新しくなる）
    found = cacheFresh_ ? {} : (cache.getAll(keys) || {});
  } catch (e) {
    console.warn('控えを読めませんでした: ' + e);
    parts.forEach(direct);
    return out;
  }

  const fresh = [];
  parts.forEach(function (part) {
    const hit = cacheJoin_(found, part, sigs[part]);
    if (hit !== undefined) {
      out[part] = hit;
      cacheStats_.hit++;
      return;
    }
    if (cacheWarmOnly_) throw { cacheWarmMiss: true };
    direct(part);
    cacheStats_.miss++;
    fresh.push(part);
  });

  // 作ったものを控える。何回かに分けて入れる（1回に入れる量を大きくしすぎない）
  let batch = {}, size = 0, batchTtl = 0;
  const send = function () {
    if (!size) return;
    try { cache.putAll(batch, batchTtl); } catch (e) { console.warn('控えを入れられませんでした: ' + e); }
    batch = {}; size = 0;
  };
  fresh.forEach(function (part) {
    const ttl = Math.min(SERVER_CACHE_SECONDS, CACHE_TTL[part] || SERVER_CACHE_SECONDS);
    if (size && ttl !== batchTtl) send();
    batchTtl = ttl;
    let chunks = null;
    try { chunks = cacheSplit_(JSON.stringify(out[part])); } catch (e) { chunks = null; }
    if (!chunks) return;
    chunks.forEach(function (piece, i) {
      if (size && size + piece.length > CACHE_PUT_CHARS) send();
      batch[cachePartKey_(part, i)] = sigs[part] + ':' + piece;
      size += piece.length;
    });
  });
  send();
  return out;
}

/** この実行で、控えを使えた数・作り直した数（画面の「読み込み」の行に出す） */
function cacheStatsNow_() {
  return { hit: cacheStats_.hit, miss: cacheStats_.miss };
}

/**
 * スプレッドシートを手で直したとき（Google が自動で呼ぶ）。直したシートの控えを、使えなくする。
 * 行の削除・挿入、スクリプトからの書き込みでは呼ばれない。
 */
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if (typeof name !== 'string' || !name) return;
    cacheBump_([name]);
    if (name === SHEET_SETTINGS || name === SHEET_TIPS) cacheDropSmall_();
  } catch (err) { /* 控えは、時間がたてば新しくなる */ }
}

// ---------------------------------------------------------------------------
// 参照の控え（v0.18.0）：スタッフ・設定・選択肢
//   どの呼び出しでも読む小さいシート（ログインの確認・設定・選択肢）を、シートでなく控えから読む。
//   書いたら印が変わるので、古いものは使わない。ロックの中・書いた直後は、シートから読む（cachedParts_ と同じ）。
//   スタッフの控えには、パスワードのハッシュは入れない（確かめるための印だけ）。
// ---------------------------------------------------------------------------
function refBuilders_() {
  return {
    refSettings: readSettingsDirect_,
    refOptions: readOptionsDirect_,
    refStaff: function () {
      return readTable_(SHEET_STAFF).rows.map(function (r) {
        return {
          id: normStaffId_(r['スタッフID']), rawId: String(r['スタッフID']), name: String(r['表示名'] || r['スタッフID']),
          enabled: r['有効'] === YES, role: r['権限'] === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF,
          stamp: passwordStamp_(r['パスワードハッシュ']), start: staffStartView_(r)
        };
      });
    }
  };
}
/** 参照の控えを1つ。同じ実行の中では1回だけ読む */
function refPart_(part) {
  if (Object.prototype.hasOwnProperty.call(refMemo_, part)) return refMemo_[part];
  const stats = { hit: cacheStats_.hit, miss: cacheStats_.miss };     // 画面の「控え ○/○」には数えない
  const value = cachedParts_([part], refBuilders_())[part];
  cacheStats_ = stats;
  refMemo_[part] = value;
  return value;
}
/** スタッフ1人（控えから）。いなければ null */
function staffRef_(staffId) {
  const id = normStaffId_(staffId);
  if (!id) return null;
  return refPart_('refStaff').filter(function (s) { return s.id === id; })[0] || null;
}

/**
 * 顧客・機器が「あるか」「どの顧客のものか」を、控えで確かめる（v0.18.0。保存のたびに顧客・機器のシートを丸ごと読まない）。
 * ロックの中でも使う。ロックを取ったあとに印を読み直すので、ほかの人が書き終えたものは見える。
 * この実行で書いたシートがあるときは、シートを読む。行番号（_row）は無い（書きかえには使わないこと）。
 */
function cachedFind_(part, sheetName, idField, id) {
  const want = String(id === null || id === undefined ? '' : id).trim();
  if (!want) return null;
  if (!cacheOn_() || hasDirtySheets_()) return findById_(sheetName, idField, want);
  if (lockDepth_ > 0) cacheGens_ = null;
  let list;
  try { list = cachedParts_([part], bootBuilders_(), null, true)[part]; } catch (e) { list = null; }
  if (!Array.isArray(list)) return findById_(sheetName, idField, want);
  for (let i = 0; i < list.length; i++) if (String(list[i][idField]) === want) return list[i];
  return null;
}

/**
 * 残りのデータを、控えだけで作れるときだけ作る（ログインの返事に付ける。v0.20.0）。
 * 控えに無い部品があれば null（画面が、あとで別に読む）。最初の画面を出すのが遅くならないように。
 */
function bootRestIfWarm_(me) {
  if (!cacheOn_()) return null;
  cacheWarmOnly_ = true;
  try {
    return bootRest_(me);
  } catch (e) {
    if (e && e.cacheWarmMiss) return null;
    console.warn('ログインの返事に残りのデータを付けられませんでした: ' + e);
    return null;
  } finally {
    cacheWarmOnly_ = false;
  }
}
