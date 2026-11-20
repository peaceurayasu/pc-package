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
 * 画面を開いたときに出す自社名とロゴ。設定シートを毎回読まないように10分おぼえておく（設定・ロゴを保存したら消す）。
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
      'スプレッドシートのメニュー「PC管理」→「初期設定」を実行してから、もう一度開いてください。');
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
  const out = {
    version: APP_VERSION,
    appName: APP_NAME,
    today: todayYmd_(),
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
    viewState: staffViewState_(findStaff_(me.id)),     // 画面設定は大きいので、スタッフの控えには入れない（開くときだけシートから）
    viewPeriodModes: VIEW_PERIOD_MODES,
    canReveal: canSeeSecrets_(me, settings),
    licenseWarnDays: settingDays_(settings, 'ライセンス期限の手前日数', 30),
    warrantyWarnDays: settingDays_(settings, '保証期限の手前日数', 60),
    repairLongDays: settingDays_(settings, '修理の長期化の日数', 7),
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
    maintKindRegular: MAINT_KIND_REGULAR,
    rentalAvailable: RENTAL_AVAILABLE,
    layoutIcons: LAYOUT_ICONS,
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
    alertCategories: ALERT_CATEGORIES
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
 * ここに足すときは、CACHE_DEPS に「もとになるシート」も書くこと（書き忘れると、保存しても画面が古いままになる）。
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
      // 「この日より後は全部そろっている」境目は、ここで1回だけ決める（画面で古い記録を直してもずれないように。v0.38.0）
      const doneList = list.filter(function (r) { return r['ステータス'] === ACTIVITY_DONE; });
      return {
        activities: list.map(function (r) { return publicRecord_(r); }),
        activityLoadedAfter: all.length > list.length && doneList.length ? String(doneList[doneList.length - 1]['受付日'] || '') : '',
        activityTotal: all.length,
        activityMonthCounts: activityMonthCounts_(all)
      };
    },
    maintenances: rowsOf(SHEET_MAINT),
    memos: rowsOf(SHEET_MEMOS),
    notices: rowsOf(SHEET_NOTICES),
    rentals: rowsOf(SHEET_RENTALS),
    loans: rowsOf(SHEET_LOANS),
    photoCounts: photoCounts_,
    wininfo: function () { return sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (r) { return publicRecord_(r); }); },
    alertStates: alertStatesForCache_
  };
  // 要対応（もとのシートごとに5つ）。顧客の表は、要るときに1回だけ読む
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

/** 最初の画面のあとに読むぶん（対応履歴・修理・ライセンス・要対応など、残りのシート） */
function bootRest_(me) {
  const started = Date.now();
  cachePrime_();                      // 控えの印は、シートを読む前に取る
  const before = cacheStatsNow_();
  const parts = bootParts_(['diagnostics', 'licenses', 'allocations', 'repairs', 'activities', 'maintenances', 'memos', 'notices',
    'rentals', 'loans', 'photoCounts', 'wininfo', 'alertStates'].concat(ALERT_PART_NAMES));
  const out = {
    diagnostics: parts.diagnostics,
    licenses: parts.licenses,
    allocations: parts.allocations,
    repairs: parts.repairs,
    activities: parts.activities.activities,
    activityTotal: parts.activities.activityTotal,
    activityLoadedAfter: parts.activities.activityLoadedAfter,
    activityMonthCounts: parts.activities.activityMonthCounts,
    maintenances: parts.maintenances,
    memos: parts.memos,
    notices: parts.notices,
    rentals: parts.rentals,
    loans: parts.loans,
    photoCounts: parts.photoCounts,
    wininfo: parts.wininfo,
    feed: feedForClient_(getSettings_()),
    alerts: alertsFromParts_(parts),
    notify: me.isAdmin ? { triggerOn: dailyTriggerOn_() } : null
  };
  out.restMs = Date.now() - started;
  out.restCache = cacheDelta_(before);
  return out;
}

/**
 * 管理画面が読むデータ。
 *   part: 'core' … 最初の画面に要るぶんだけ（速い）
 *   part: 'rest' … 残り
 *   省略         … 全部（1回で）
 * 画面は、開き直したときに core と rest を同時に呼ぶ。ログインのときは、login の返事に core が付いてくる。
 *   fresh: true  … 控え（サーバー側のキャッシュ）を使わずに、シートから読み直す（画面の「最新を読み込む」）
 * @param {{token:string, part:string=, fresh:boolean=}} params
 */
function getBootstrap(params) {
  return api_(function () {
    const me = requireSession_(params && params.token);
    if (params && params.fresh === true) { cacheBumpAll_(); cacheFresh_ = true; }
    cachePrime_();
    const part = params && params.part;
    if (part === 'core') return bootCore_(me);
    if (part === 'rest') return bootRest_(me);
    const out = bootCore_(me);
    const rest = bootRest_(me);
    Object.keys(rest).forEach(function (k) { out[k] = rest[k]; });
    return out;
  });
}

/**
 * 1顧客の対応履歴を全件返す（最初の読み込みは件数に上限があるため）。
 * @param {{token:string, customerId:string}} params
 */
function listActivities(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token);
    const customerId = cleanText_(p.customerId);
    // 期間（from〜to）で取ることもできる。対応履歴の画面で、最初に読んだぶんより古い期間を見るときに使う
    const from = p.from === undefined || p.from === '' ? '' : parseYmd_(p.from);
    const to = p.to === undefined || p.to === '' ? '' : parseYmd_(p.to);
    if (from === null || to === null) throw appError_('invalid', '期間の日付が正しくありません。');
    if (!customerId && !(from && to)) throw appError_('invalid', '顧客か期間を指定してください。');
    const rows = readTable_(SHEET_ACTIVITIES).rows.filter(function (r) {
      if (customerId && String(r['顧客ID']) !== customerId) return false;
      const d = String(r['受付日']);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    return { activities: sortActivities_(rows).map(function (r) { return publicRecord_(r); }) };
  });
}
