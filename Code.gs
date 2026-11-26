/**
 * Code.gs … ウェブアプリの入口と、管理画面の最初の読み込み
 *
 * URL の使い分け
 *   .../exec            … スタッフ用の管理画面（ログインが要る）
 *   .../exec?t=トークン … お客様ビュー（顧客ごとに発行したURL。ログイン不要）
 *   .../exec?action=version|download&token=受信トークン … 収集ツールの自動更新（Release.gs。JSON で答える）
 *
 * 公開関数：doGet / getBootstrap / listActivities
 * （収集ツールからの受信 doPost は Receiver.gs）
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Code.gs'] = '0.140.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

/**
 * 初期設定が済んでいるか（シートが全部あるか）。
 * 済んでいると分かったら6時間おぼえておく（画面を開くたびに20枚ぶん調べると、そのぶん開くのが遅くなる）。
 */
function isSetupDone_() {
  const cache = CacheService.getScriptCache();
  const key = 'setupOk_' + APP_VERSION;
  if (cache.get(key) === '1') return true;
  const names = {};
  getSs_().getSheets().forEach(function (sh) { names[sh.getName()] = true; });
  const done = SHEET_ORDER.every(function (name) { return names[name]; });
  if (done) cache.put(key, '1', 21600);
  return done;
}

const BRAND_CACHE_KEY = 'brand';
/**
 * 画面を開いた時に出す自社名とロゴ。設定シートを毎回読まないように10分おぼえておく（設定・ロゴを保存したら消す）。
 * @return {{company:string, logo:string}}
 */
function brandCached_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(BRAND_CACHE_KEY);
  if (hit) {
    try { const b = JSON.parse(hit); return { company: String(b.company || ''), logo: cleanImageDataUrl_(b.logo, LOGO_MAX_CHARS) }; } catch (e) { /* 壊れていたら読み直す */ }
  }
  let brand;
  try {
    const settings = getSettings_();
    brand = { company: String(settings['自社名'] || ''), logo: logoOf_(settings) };
  } catch (err) { return { company: '', logo: '' }; }
  cache.put(BRAND_CACHE_KEY, JSON.stringify(brand), 600);
  return brand;
}

function messagePage_(title, message) {
  const html = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"></head>' +
    '<body style="font-family:sans-serif;padding:32px;color:#1f2933">' +
    '<h1 style="font-size:20px">' + title + '</h1><p>' + message + '</p></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  const q = (e && e.parameter) || {};
  // 収集ツールの自動更新の問い合わせ（Release.gs）。画面ではなく JSON で答える
  if (q.action === 'version' || q.action === 'download') {
    if (!isSetupDone_()) return jsonOutput_({ ok: false, error: 'setup' });
    return toolUpdateGet_(q);
  }
  if (!isSetupDone_()) {
    return messagePage_('初期設定を実行してください',
      'スプレッドシートのメニュー「' + APP_NAME + '」→「初期設定」を実行してから、もう一度開いてください。');
  }
  const p = (e && e.parameter) || {};
  const brand = brandCached_();
  const company = brand.company;

  if (p.t !== undefined) {
    // 形がおかしいトークンは、画面を出す前に弾く（テンプレートに埋め込む値を16進だけに限るため）
    if (!/^[0-9a-f]{64}$/.test(String(p.t))) {
      return messagePage_('このURLは使えません', 'URLが正しいか、担当者に確認してください。');
    }
    const portal = HtmlService.createTemplateFromFile('Portal');
    portal.portalToken = String(p.t);
    portal.appVersion = APP_VERSION;
    portal.logo = brand.logo;
    return portal.evaluate().setTitle((company ? company + ' ' : '') + 'お客様ページ')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  const admin = HtmlService.createTemplateFromFile('Admin');
  admin.appVersion = APP_VERSION;
  admin.appName = APP_NAME;
  admin.company = company;
  admin.logo = brand.logo;
  admin.rememberDays = REMEMBER_DAYS;
  return admin.evaluate().setTitle((company ? company + ' ' : '') + APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** HTMLのテンプレートから、別のHTMLファイル（AdminCss など）の中身をそのまま差し込む（v0.97.0。画面を分けた部品用） */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(String(name)).getContent();
}

/**
 * 差し替え漏れのファイル（v0.111.0）。FILE_MANIFEST の版と合わないファイルの名前を返す（管理者の画面に出す）。
 *   .gs は FILE_VERSIONS_、.html は中の「@file-version x.y.z」を見る。古い版のファイルには印が無いので、それも漏れとして出す。
 *   5分だけ控える（毎回 HTML を読み直さない）。
 */
function staleFiles_() {
  const key = 'staleFiles_' + APP_VERSION;
  let cache = null;
  try { cache = CacheService.getScriptCache(); const hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (e) { cache = null; }
  const out = [];
  const have = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {};
  Object.keys(FILE_MANIFEST).forEach(function (name) {
    const want = FILE_MANIFEST[name];
    let got = '';
    if (/\.gs$/.test(name)) got = have[name] || '';
    else {
      try {
        const m = /@file-version (\d+\.\d+\.\d+)/.exec(HtmlService.createHtmlOutputFromFile(name.replace(/\.html$/, '')).getContent());
        got = m ? m[1] : '';
      } catch (e) { got = ''; }
    }
    if (got !== want) out.push({ name: name, want: want, got: got });
  });
  try { if (cache) cache.put(key, JSON.stringify(out), 300); } catch (e) { /* 控えられなくても返す */ }
  return out;
}

/** 画面のフォームに渡す項目定義 */
function entitySchema_() {
  const out = {};
  Object.keys(ENTITIES).forEach(function (key) {
    const ent = ENTITIES[key];
    out[key] = { label: ent.label, idField: ent.idField, nameField: ent.nameField, fields: ent.fields };
  });
  return out;
}

function compareDesc_(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

function sortActivities_(rows) {
  return rows.slice().sort(function (a, b) {
    return compareDesc_(String(a['受付日']), String(b['受付日'])) || compareDesc_(String(a['対応ID']), String(b['対応ID']));
  });
}

/** 全体の設定と本人の選択から、開いた直後の画面を決める */
function effectiveStartView_(me, settings) {
  if (me.startView) return me.startView;
  const v = String(settings['開いた直後の画面'] || '');
  return START_VIEWS.indexOf(v) !== -1 ? v : START_VIEWS[0];
}

/**
 * 最初の画面を出すのに要るぶん（読むシートは スタッフ・設定・選択肢・顧客・機器 の5枚）。
 * ログインの返事にも、これを付ける。
 */
function bootCore_(me) {
  const started = Date.now();
  cachePrime_();                      // 控えの印は、シートを読む前に取る
  const before = cacheStatsNow_();
  const settings = getSettings_();
  const parts = bootParts_(['customers', 'devices']);
  const staffRow = findStaff_(me.id);
  const out = {
    version: APP_VERSION,
    staleFiles: me.isAdmin ? staleFiles_() : [],     // 差し替え漏れ（管理者だけに出す。v0.111.0）
    appName: APP_NAME,
    today: todayYmd_(),
    stamp: nowStamp_(),            // 「新着だけ読み込む」の目印（v0.67.0）
    me: me,
    settings: publicSettings_(settings),
    logo: logoOf_(settings),
    startView: effectiveStartView_(me, settings),
    startViews: START_VIEWS,
    tips: tipsForClient_(settings),
    phraseDefaults: OPTION_DEFAULTS['対応の定型文'],
    wininfoShowDays: WININFO_SHOW_DAYS,
    wininfoShowMax: WININFO_SHOW_MAX,
    wininfoPins: winInfoPins_(),
    viewState: staffViewState_(staffRow),
    mustChangePassword: isTempPassword_(staffRow),      // 仮パスワードのまま（画面がパスワードの変更を促す。v0.128.0）     // 画面設定は大きいので、スタッフの控えには入れない（開く時だけシートから）
    viewPeriodModes: VIEW_PERIOD_MODES,
    canReveal: canSeeSecrets_(me, settings),
    licenseWarnDays: settingDays_(settings, 'ライセンス期限の手前日数', 30),
    warrantyWarnDays: settingDays_(settings, '保証期限の手前日数', 60),
    repairLongDays: settingDays_(settings, '修理の長期化の日数', 7),
    staleDays: settingDays_(settings, '放置の目安の日数', 3),      // v0.140.0：未完了で、この日数動きが無いものを一覧で目立たせる
    options: getOptions_(),
    optionCategories: OPTION_CATEGORIES,
    staffNames: activeStaffNames_(),
    schema: entitySchema_(),
    roles: ROLES,
    activityDone: ACTIVITY_DONE,
    repairDone: REPAIR_DONE,
    customers: parts.customers,
    devices: parts.devices,
    rentalOn: settings['レンタル機器を使う'] !== NO,
    bizOn: settings['営業・案件ツール（テスト版）を使う'] !== NO,      // 開発案件・営業（テスト版）を使うか（v0.81.0）
    bizStates: { project: PROJECT_STATES, projectActive: PROJECT_ACTIVE, sales: PROJECT_SALES, lost: PROJECT_LOST, hold: PROJECT_HOLD, maintain: PROJECT_MAINTAIN, ordered: PROJECT_ORDERED, delivered: PROJECT_DELIVERED },
    feed: feedForClient_(settings),   // 自動更新（RSS）の状態（軽いので、core に入れる。v0.69.0）
    maintKindRegular: MAINT_KIND_REGULAR,
    rentalAvailable: RENTAL_AVAILABLE,
    layoutIcons: LAYOUT_ICONS,
    layoutNetKinds: LAYOUT_NET_KINDS,
    layoutLinkKinds: LAYOUT_LINK_KINDS,
    layoutMaxElements: LAYOUT_MAX_ELEMENTS,
    layoutPolyMaxPoints: LAYOUT_POLY_MAX_POINTS,
    attachMaxBytes: ATTACH_MAX_BYTES,
    attachExtensions: Object.keys(ATTACH_TYPES),
    layoutImageMaxBytes: LAYOUT_IMAGE_MAX_BYTES,
    logoMaxChars: LOGO_MAX_CHARS,
    photoMaxBytes: PHOTO_MAX_BYTES,
    photoThumbMaxChars: PHOTO_THUMB_MAX_CHARS,
    photoMax: PHOTO_MAX_PER_RECORD,
    scanPdfMaxBytes: SCAN_PDF_MAX_BYTES,
    reportNoteMax: REPORT_NOTE_MAX,
    scanPdfMaxPages: SCAN_PDF_MAX_PAGES,
    photoKinds: Object.keys(PHOTO_TARGETS),
    alertCategories: ALERT_CATEGORIES,
    maintPlanRan: maintPlanRanMonth_()      // v0.119.0
  };
  out.coreMs = Date.now() - started;
  out.coreCache = cacheDelta_(before);
  return out;
}

/** 控えを使えた数・作り直した数（この呼び出しのぶん） */
function cacheDelta_(before) {
  const now = cacheStatsNow_();
  return { hit: now.hit - before.hit, miss: now.miss - before.miss };
}

/**
 * 画面に渡す部品を作る関数。名前は Config.gs の CACHE_DEPS と同じ。
 * ここに足す時は、CACHE_DEPS に「もとになるシート」も書くこと（書き忘れると、保存しても画面が古いままになる）。
 */
function bootBuilders_() {
  const rowsOf = function (sheetName) {
    return function () { return readTable_(sheetName).rows.map(function (r) { return publicRecord_(r); }); };
  };
  const out = {
    customers: function () { return readTable_(SHEET_CUSTOMERS).rows.map(function (r) { return toClient_('customer', r); }); },
    devices: rowsOf(SHEET_DEVICES),
    diagnostics: function () {
      return readTable_(SHEET_DIAGNOSTICS, DIAG_LEAN_SKIP).rows.map(function (r) {
        return pick_(r, ['機器ID', '受信日時', 'コンピューター名', 'OS', 'イベント重大', 'イベントエラー', 'Cドライブ空き', 'レポート添付ID', 'レポート受信日時']);
      });
    },
    licenses: rowsOf(SHEET_LICENSES),
    allocations: rowsOf(SHEET_ALLOCATIONS),
    repairs: rowsOf(SHEET_REPAIRS),
    activities: function () {
      const all = sortActivities_(readTable_(SHEET_ACTIVITIES).rows);
      // 新しい順に上限まで。完了していないものは古くても必ず入れる
      const list = all.filter(function (r, i) {
        return i < MAX_ACTIVITIES_IN_BOOTSTRAP || r['ステータス'] !== ACTIVITY_DONE;
      });
      return {
        activities: list.map(function (r) { return publicRecord_(r); }),
        activityTotal: all.length,
        activityMonthCounts: activityMonthCounts_(all)
      };
    },
    maintenances: rowsOf(SHEET_MAINT),
    memos: rowsOf(SHEET_MEMOS),
    notices: rowsOf(SHEET_NOTICES),
    rentals: rowsOf(SHEET_RENTALS),
    loans: rowsOf(SHEET_LOANS),
    projects: rowsOf(SHEET_PROJECTS),
    saleslogs: rowsOf(SHEET_SALESLOGS),
    photoCounts: photoCounts_,
    wininfo: function () { return sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (r) { return publicRecord_(r); }); },
    alertStates: alertStatesForCache_
  };
  // 要対応（元のシートごとに5つ）。顧客の表は、要る時に1回だけ読む
  let ctx = null;
  ALERT_PART_NAMES.forEach(function (name) {
    out[name] = function () {
      ctx = ctx || alertContext_();
      return alertSources_()[name](ctx);
    };
  });
  return out;
}

/** 部品を取る（控えがあれば控えから）。要対応は日付で中身が変わるので、キーに今日の日付を入れる */
function bootParts_(names) {
  const today = todayYmd_();
  const extras = {};
  ALERT_PART_NAMES.forEach(function (name) { extras[name] = today; });
  return cachedParts_(names, bootBuilders_(), extras);
}

/** 月ごとの対応件数（全期間）。{'2026-09': 12, …}。画面には件数に上限があるので、推移はここで数える */
function activityMonthCounts_(rows) {
  const out = {};
  rows.forEach(function (r) {
    const m = String(r['受付日']).slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) out[m] = (out[m] || 0) + 1;
  });
  return out;
}

/**
 * 「残り」のデータを、グループに分ける（v0.69.0）。画面は、開いたタブに要るグループだけを、並べて読む。
 *   alert … 要対応            act  … 対応履歴          diag … 機器診断（収集ツールの情報）
 *   win   … Windows情報       lic  … ライセンス・割当・レンタル・貸出
 *   rep   … 修理              mnt  … 保守の記録        misc … 社内メモ・お知らせ・写真の数・毎朝の通知の設定
 *   （自動更新の状態 feed は軽いので、core に入れる）
 */
function bootGroupDefs_() {
  return {
    alert: ['alertStates'].concat(ALERT_PART_NAMES),
    act: ['activities'],
    diag: ['diagnostics'],
    win: ['wininfo'],
    lic: ['licenses', 'allocations', 'rentals', 'loans'],
    rep: ['repairs'],
    mnt: ['maintenances'],
    misc: ['memos', 'notices', 'photoCounts', 'projects', 'saleslogs']
  };
}

/**
 * 最初の画面の後に読むぶん（対応履歴・修理・ライセンス・要対応など、残りのシート）。
 * groups を渡すと、そのグループだけ（省略すると、全部）。返事の groups に、入れたグループを書く。
 */
/**
 * スマホに渡す対応履歴を、完了していないものと、直近 PHONE_ACT_DAYS 日のものだけにする（v0.132.0。電波が弱い現場で、読み込みを軽く）。
 * 全体の件数（activityTotal）はそのまま渡すので、画面は「古い分はまだ読んでいない」と分かり、要るとき（期間を選ぶ・顧客の画面）に読む。
 */
function liteActivities_(list) {
  const p = todayYmd_().split('-');
  const from = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - PHONE_ACT_DAYS), scriptTz_(), 'yyyy-MM-dd');
  return list.filter(function (a) { return a['ステータス'] !== ACTIVITY_DONE || String(a['受付日'] || '') >= from; });
}

/** v0.136.0：スマホに渡す修理も、終わっていないものと、直近 PHONE_ACT_DAYS 日に受け付けた・終わったものだけにする（全部の件数は repairTotal で渡す） */
function liteRepairs_(list) {
  const p = todayYmd_().split('-');
  const from = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - PHONE_ACT_DAYS), scriptTz_(), 'yyyy-MM-dd');
  return list.filter(function (r) { return r['ステータス'] !== REPAIR_DONE || String(r['受付日'] || '') >= from || String(r['完了日'] || '') >= from; });
}

function bootRest_(me, groups, lite) {
  const started = Date.now();
  const defs = bootGroupDefs_();
  let want = Object.keys(defs);
  if (groups !== undefined && groups !== null) {
    if (!Array.isArray(groups)) throw appError_('invalid', '読み込むグループの指定が正しくありません。');
    want = want.filter(function (g) { return groups.indexOf(g) !== -1; });
    groups.forEach(function (g) { if (!defs[g]) throw appError_('invalid', '読み込むグループの指定が正しくありません。'); });
  }
  const has = function (g) { return want.indexOf(g) !== -1; };
  cachePrime_();                      // 控えの印は、シートを読む前に取る
  const before = cacheStatsNow_();
  const restStamp = nowStamp_();       // 「更新」で差分を受ける時の、前回の時刻（v0.106.0。読む前に取る）
  let names = [];
  want.forEach(function (g) { names = names.concat(defs[g]); });
  const parts = bootParts_(names);
  const out = { groups: want, restStamp: restStamp };
  if (has('diag')) out.diagnostics = parts.diagnostics;
  if (has('lic')) { out.licenses = parts.licenses; out.allocations = parts.allocations; out.rentals = parts.rentals; out.loans = parts.loans; }
  if (has('rep')) { out.repairs = lite === true ? liteRepairs_(parts.repairs) : parts.repairs; out.repairTotal = parts.repairs.length; }
  if (has('act')) {
    out.activities = lite === true ? liteActivities_(parts.activities.activities) : parts.activities.activities;
    out.activityTotal = parts.activities.activityTotal;
    out.activityMonthCounts = parts.activities.activityMonthCounts;
  }
  if (has('mnt')) out.maintenances = parts.maintenances;
  if (has('misc')) {
    out.memos = parts.memos;
    out.notices = parts.notices;
    out.photoCounts = parts.photoCounts;
    out.projects = parts.projects;
    out.saleslogs = parts.saleslogs;
    out.notify = me.isAdmin ? { triggerOn: dailyTriggerOn_() } : null;
  }
  if (has('win')) out.wininfo = parts.wininfo;
  if (has('alert')) out.alerts = alertsFromParts_(parts);
  out.restMs = Date.now() - started;
  out.restCache = cacheDelta_(before);
  return out;
}

/**
 * 管理画面が読むデータ。
 *   part: 'core' … 最初の画面に要るぶんだけ（速い）
 *   part: 'rest' … 残り（groups に ['act','rep',…] を渡すと、そのグループだけ。v0.69.0）
 *   省略         … 全部（1回で）
 * 画面は、開き直した時に core と rest を同時に呼ぶ。ログインの時は、login の返事に core が付いてくる。
 *   fresh: true  … 控え（サーバー側のキャッシュ）を使わずに、シートから読み直す（画面の「最新を読み込む」）
 * @param {{token:string, part:string=, fresh:boolean=}} params
 */
function getBootstrap(params) {
  return apiPack_(params, function () {
    const me = requireSession_(params && params.token);
    if (params && params.fresh === true) { cacheBumpAll_(); cacheFresh_ = true; }
    cachePrime_();
    const part = params && params.part;
    if (part === 'core') return bootCore_(me);
    if (part === 'rest') return bootRest_(me, params.groups, params.lite === true);
    const out = bootCore_(me);
    const rest = bootRest_(me);
    Object.keys(rest).forEach(function (k) { out[k] = rest[k]; });
    return out;
  });
}

/** 'yyyy-MM-dd HH:mm' を n 分ずらす（v0.67.0） */
function shiftMinutes_(ymdHm, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(ymdHm));
  if (!m) return String(ymdHm);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]) + delta);
  return Utilities.formatDate(d, scriptTz_(), 'yyyy-MM-dd HH:mm');
}

/**
 * 新しく届いた・直したぶんだけを返す（スマホの「更新」用。v0.67.0）。
 *   顧客・機器・機器診断の3つだけを、シートから読む（他のシートは読まない。控えも作り直さない）。
 *   since より新しい行だけを返す（取りこぼさないよう、30分さかのぼる。同じ行を2回受けても、画面で上書きするだけ）。
 *   消された行を知らせるため、今あるIDの一覧も返す。
 *   手でシートを直した行（更新日時が変わらない）は拾えない。その時は、メニューの「全て読み直す」を使う。
 * @param {{token:string, since:string}} params  since は前の返事の stamp
 */
function getChanges(params) {
  return apiPack_(params, function () {
    const p = params || {};
    requireSession_(p.token);
    return changesCore_(p);
  });
}

/** getChanges の中身（getViewChanges からも呼ぶ。v0.111.0：「更新」を1回の呼び出しにまとめるため） */
function changesCore_(p) {
  {
    const since = parseYmdHm_(p.since);
    if (!since) throw appError_('invalid', '前回の読み込みの時刻が正しくありません。');
    const from = shiftMinutes_(since, -CHANGES_MARGIN_MIN);
    const stamp = nowStamp_();
    // cached: true … 控え（サーバー側のキャッシュ）から読む。アプリで保存したものは必ず入る（保存で控えが作り直されるため）。シートを手で直したぶんは、「全て読み直す」で（v0.95.0）
    const useCache = p.cached === true;
    if (useCache) cachePrime_();
    const b = bootBuilders_();
    const got = useCache ? bootParts_(['customers', 'devices'].concat(p.withDiag === false ? [] : ['diagnostics'])) : null;
    const customers = got ? got.customers : b.customers(), devices = got ? got.devices : b.devices();
    // 収集ツールの情報は、画面が読んでいる時だけ（スマホの一覧は読んでいないので、シートも読まない。v0.79.0）
    const diags = p.withDiag === false ? [] : got ? got.diagnostics : b.diagnostics();
    const newer = function (v) { return String(v || '') >= from; };
    return {
      stamp: stamp,
      customers: customers.filter(function (c) { return newer(c['更新日時']); }),
      devices: devices.filter(function (d) { return newer(d['更新日時']); }),
      diagnostics: diags.filter(function (g) { return newer(g['受信日時']) || newer(g['レポート受信日時']); }),
      customerIds: customers.map(function (c) { return String(c['顧客ID']); }),
      deviceIds: devices.map(function (d) { return String(d['機器ID']); }),
      diagnosticIds: diags.map(function (g) { return String(g['機器ID']); })
    };
  }
}

/** 差分で返す表（グループごとのデータ名 → ID の列）。更新日時が無い表（割当）や、軽いもの（写真の数など）は、そのまま返す */
const VIEW_DELTA_TABLES = {
  activities: '対応ID', repairs: '修理ID', maintenances: '実施ID', licenses: 'ライセンスID', rentals: 'レンタルID', loans: '貸出ID',
  memos: 'メモID', notices: 'お知らせID', projects: '案件ID', saleslogs: '営業ID', wininfo: '情報ID'
};

/**
 * 今見ている画面のグループについて、新しく届いた・直したぶんだけを返す（「更新」ボタン用。v0.95.0）。
 *   groups … 読み直すグループ（diag は getChanges が受け持つ）
 *   since  … グループごとの前回の時刻 {act:'2026-10-25 10:00', …}（前の返事の stamp）
 * 返事の delta[データ名] = { recs: 新着・直したぶん, ids: 今あるID（消されたものを知らせる。null なら消さない） }
 * full … 差分にしないもの（割当・写真の数・月ごとの件数など）は、そのまま入る。
 * 控え（サーバー側のキャッシュ）から作るので、アプリで保存したぶんは必ず入る。シートを手で直したぶんは「全て読み直す」で。
 * @param {{token:string, groups:string[], since:Object}} params
 */
function getViewChanges(params) {
  return apiPack_(params, function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const defs = bootGroupDefs_();
    const groups = p.groups;
    if (!Array.isArray(groups) || !groups.length) throw appError_('invalid', '読み込むグループの指定が正しくありません。');
    groups.forEach(function (g) { if (!defs[g] || g === 'diag') throw appError_('invalid', '読み込むグループの指定が正しくありません。'); });
    const stamp = nowStamp_();
    const sinceOf = {};
    groups.forEach(function (g) {
      const s = p.since && parseYmdHm_(p.since[g]);
      if (!s) throw appError_('invalid', '前回の読み込みの時刻が正しくありません。');
      sinceOf[g] = shiftMinutes_(s, -CHANGES_MARGIN_MIN);
    });
    cachePrime_();
    let names = [];
    groups.forEach(function (g) { names = names.concat(defs[g]); });
    const parts = bootParts_(names);
    const out = { stamp: stamp, groups: groups, delta: {}, full: {} };
    const delta = function (g, name, rows, keepAll) {
      const from = sinceOf[g], idField = VIEW_DELTA_TABLES[name];
      out.delta[name] = {
        recs: rows.filter(function (r) { return String(r['更新日時'] || '') >= from; }),
        ids: keepAll ? null : rows.map(function (r) { return String(r[idField]); })
      };
    };
    const has = function (g) { return groups.indexOf(g) !== -1; };
    if (has('act')) {
      // 画面には新しい順に上限まである。上限から外れたものを消さないよう、IDの列は返さない（他の人が消したぶんは「全て読み直す」で）
      delta('act', 'activities', parts.activities.activities, true);
      out.full.activityTotal = parts.activities.activityTotal;
      out.full.activityMonthCounts = parts.activities.activityMonthCounts;
    }
    if (has('rep')) delta('rep', 'repairs', parts.repairs);
    if (has('mnt')) delta('mnt', 'maintenances', parts.maintenances);
    if (has('lic')) {
      delta('lic', 'licenses', parts.licenses);
      delta('lic', 'rentals', parts.rentals);
      delta('lic', 'loans', parts.loans);
      out.full.allocations = parts.allocations;
    }
    if (has('misc')) {
      delta('misc', 'memos', parts.memos);
      delta('misc', 'notices', parts.notices);
      delta('misc', 'projects', parts.projects);
      delta('misc', 'saleslogs', parts.saleslogs);
      out.full.photoCounts = parts.photoCounts;
      out.full.notify = me.isAdmin ? { triggerOn: dailyTriggerOn_() } : null;
    }
    if (has('win')) delta('win', 'wininfo', parts.wininfo);
    if (has('alert')) out.alerts = alertsFromParts_(parts);
    // 顧客・機器・収集ツールの差分も、同じ返事で返す（v0.111.0。前は getChanges を別に呼んでいた＝サーバーの呼び出しが2回）
    if (p.core && typeof p.core === 'object') out.core = changesCore_({ since: p.core.since, withDiag: p.core.withDiag, cached: true });
    return out;
  });
}

/**
 * 1顧客の対応履歴を全件返す（最初の読み込みは件数に上限があるため）。
 * @param {{token:string, customerId:string}} params
 */
function listActivities(params) {
  return apiPack_(params, function () {
    const p = params || {};
    requireSession_(p.token);
    const customerId = cleanText_(p.customerId);
    // 期間（from〜to）で取ることもできる。対応履歴の画面で、最初に読んだぶんより古い期間を見る時に使う
    const from = p.from === undefined || p.from === '' ? '' : parseYmd_(p.from);
    const to = p.to === undefined || p.to === '' ? '' : parseYmd_(p.to);
    if (from === null || to === null) throw appError_('invalid', '期間の日付が正しくありません。');
    if (!customerId && !(from && to)) throw appError_('invalid', '顧客か期間を指定してください。');
    // 退避シート（古い対応履歴。v0.112.0）も一緒に読む。普段の読み込みでは読まない
    const rows = readTable_(SHEET_ACTIVITIES).rows.concat(archivedActivities_()).filter(function (r) {
      if (customerId && String(r['顧客ID']) !== customerId) return false;
      const d = String(r['受付日']);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    return { activities: sortActivities_(rows).map(function (r) { return publicRecord_(r); }) };
  });
}
