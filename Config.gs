/**
 * PC管理パッケージ
 * Config.gs … 版、シートの定義、固定の選択肢、入力項目の定義
 *
 * このファイルは「何を持つか」だけを書く。処理は書かない。
 * シートの列を足すときは SCHEMA に追記して「初期設定」を実行する（既存の列は消さない・並べ替えない）。
 */
var FILE_VERSIONS_ = (typeof FILE_VERSIONS_ !== 'undefined' && FILE_VERSIONS_) || {}; FILE_VERSIONS_['Config.gs'] = '0.137.0';   // このファイルの版（差し替え漏れの確かめ。v0.111.0）

const APP_VERSION = '0.137.0';

// ---------------------------------------------------------------------------
// 差し替え漏れの確かめ（v0.111.0）
//   ファイルごとの「あるべき版」。.gs は FILE_VERSIONS_、.html は中の「@file-version」と比べる。
//   ファイルを直したら、そのファイルの印と、ここの版を一緒に上げる（Config.gs は毎回差し替える）。
// ---------------------------------------------------------------------------
const FILE_MANIFEST = {
  'Admin.html': '0.136.0',
  'AdminActions.html': '0.137.0',
  'AdminCore.html': '0.137.0',
  'AdminCss.html': '0.136.0',
  'AdminMobile.html': '0.137.0',
  'AdminModals.html': '0.136.0',
  'AdminViews.html': '0.137.0',
  'Alerts.gs': '0.123.0',
  'Auth.gs': '0.128.2',
  'Code.gs': '0.136.0',
  'Config.gs': '0.137.0',
  'Db.gs': '0.136.0',
  'Portal.gs': '0.111.0',
  'Portal.html': '0.122.0',
  'Receiver.gs': '0.111.0',
  'Records.gs': '0.136.0',
  'Setup.gs': '0.136.0'
};
const APP_NAME = '管理システム';

// ---------------------------------------------------------------------------
// シート名
// ---------------------------------------------------------------------------
const SHEET_SETTINGS = '設定';
const SHEET_STAFF = 'スタッフ';
const SHEET_OPTIONS = '選択肢';
const SHEET_CUSTOMERS = '顧客';
const SHEET_DEVICES = '機器';
const SHEET_DIAGNOSTICS = '機器診断';
const SHEET_LICENSES = 'ライセンス';
const SHEET_ALLOCATIONS = 'ライセンス割当';
const SHEET_CREDENTIALS = '認証情報';
const SHEET_ACTIVITIES = '対応履歴';
const SHEET_REPAIRS = '修理案件';
const SHEET_MAINT = '保守実施';
const SHEET_MEMOS = '社内メモ';
const SHEET_NOTICES = 'お知らせ';
const SHEET_ATTACH = '添付';
const SHEET_LAYOUTS = 'レイアウト';
const SHEET_RENTALS = 'レンタル機器';
const SHEET_LOANS = '貸出記録';
const SHEET_ALERTS = 'アラート状態';
const SHEET_AUDIT = '変更履歴';
const SHEET_WININFO = 'Windows情報';
const SHEET_TIPS = 'Tips';
// テスト版（v0.81.0）：お客様向けWebアプリ開発の進捗と、営業（商談・営業活動）
const SHEET_PROJECTS = '開発案件';
const SHEET_DEALS = '商談';
const SHEET_SALESLOGS = '営業活動';

// ---------------------------------------------------------------------------
// 列の定義  [列名, 型]
//   text     … 文字（書式は「書式なしテキスト」。電話番号の先頭0や、日付に見える文字が勝手に変換されない）
//   date     … 日付（yyyy-MM-dd）
//   datetime … 日時（yyyy-MM-dd HH:mm）
//   number   … 数値
// ---------------------------------------------------------------------------
const SCHEMA = {};
SCHEMA[SHEET_SETTINGS] = [['キー', 'text'], ['値', 'text'], ['説明', 'text']];
SCHEMA[SHEET_STAFF] = [
  ['スタッフID', 'text'], ['表示名', 'text'], ['パスワードハッシュ', 'text'], ['権限', 'text'],
  ['有効', 'text'], ['最終ログイン', 'datetime'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['開始画面', 'text'], ['画面設定', 'text']                       // 開いた直後の画面（本人が選ぶ。空なら全体の設定に合わせる）
];
SCHEMA[SHEET_OPTIONS] = [['区分', 'text'], ['値', 'text'], ['表示順', 'number'], ['有効', 'text']];
SCHEMA[SHEET_CUSTOMERS] = [
  ['顧客ID', 'text'], ['顧客名', 'text'], ['ふりがな', 'text'], ['郵便番号', 'text'], ['住所', 'text'],
  ['地域', 'text'], ['電話', 'text'], ['メール', 'text'], ['先方担当者', 'text'], ['保守契約', 'text'],
  ['状態', 'text'], ['ポータル公開', 'text'], ['ポータル表示', 'text'], ['ポータルトークン', 'text'],
  ['受信トークン', 'text'],  ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ひとこと', 'text'],     // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
  ['契約更新日', 'date'],   // v0.123.0：保守契約の更新日（この日の手前で、要対応に「ご報告書をお持ちする」を出す）
  ['月額保守料金', 'number'] // v0.123.0（v0.125.0 で年額→月額）：保守のご報告書で「スポットで頼んだ場合」と比べる（×12か月）
];
SCHEMA[SHEET_DEVICES] = [
  ['機器ID', 'text'], ['顧客ID', 'text'], ['状況', 'text'], ['種類', 'text'], ['設置場所', 'text'],
  ['部署', 'text'], ['利用者', 'text'], ['ふりがな', 'text'], ['メーカー', 'text'], ['機種名', 'text'],
  ['シリアル', 'text'], ['購入日', 'date'], ['購入元', 'text'], ['保証期限', 'date'], ['備考', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ESET', 'date'],       // v0.99.1：ESET の期限（前から手で足してあったシートの列を、画面から直せるようにした）
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
// 収集ツール（PCInfoTool）が送ってくる最新の値。1機器1行。手入力の台帳（機器シート）とは分けて持つ
SCHEMA[SHEET_DIAGNOSTICS] = [
  ['機器ID', 'text'], ['受信日時', 'datetime'], ['シリアル', 'text'], ['メーカー（取得値）', 'text'], ['機種名（取得値）', 'text'],
  ['コンピューター名', 'text'], ['IPアドレス', 'text'], ['OS', 'text'], ['CPU', 'text'], ['メモリ', 'text'], ['ストレージ', 'text'],
  ['イベント重大', 'number'], ['イベント重大（内容）', 'text'], ['イベントエラー', 'number'], ['イベントエラー（内容）', 'text'],
  ['ディスク関連イベント', 'text'], ['プリンター情報', 'text'], ['BitLocker', 'text'], ['Windows Update', 'text'],
  ['ウイルス対策ソフト', 'text'], ['バッテリー状態', 'text'], ['稼働時間', 'text'], ['クラッシュダンプ', 'text'],
  ['前回メンテナンス', 'text'], ['ツールバージョン', 'text'],
  // v0.25.0：収集ツール v1.6.0〜 が送る項目（スタートアップ・前回との比較）、v1.7.0〜 のCドライブ空きとレポート（添付）
  ['スタートアップ', 'text'], ['前回との比較', 'text'], ['Cドライブ空き', 'text'], ['レポート添付ID', 'text'], ['レポート受信日時', 'datetime']
];
SCHEMA[SHEET_LICENSES] = [
  ['ライセンスID', 'text'], ['顧客ID', 'text'], ['製品名', 'text'], ['契約期間', 'text'], ['数量', 'number'],
  ['有効期限', 'date'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['不使用', 'text'],     // v0.99.0：期限切れ・不要になったものに「はい」（消さずに残す。期限の要対応に出さない）
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
SCHEMA[SHEET_ALLOCATIONS] = [['割当ID', 'text'], ['ライセンスID', 'text'], ['機器ID', 'text'], ['割当日', 'date']];
SCHEMA[SHEET_CREDENTIALS] = [
  ['認証ID', 'text'], ['顧客ID', 'text'], ['対象区分', 'text'], ['対象ID', 'text'], ['名称', 'text'],
  ['ログインID', 'text'], ['パスワード', 'text'], ['シリアルキー', 'text'], ['備考', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_ACTIVITIES] = [
  ['対応ID', 'text'], ['顧客ID', 'text'], ['機器ID', 'text'], ['受付日', 'date'], ['受付方法', 'text'],
  ['対応種別', 'text'], ['インシデント種別', 'text'], ['先方担当者', 'text'], ['受付スタッフ', 'text'],
  ['開始日時', 'datetime'], ['完了日時', 'datetime'], ['ステータス', 'text'], ['内容', 'text'],
  ['ピン留め', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['案件ID', 'text'],     // v0.81.0：開発案件のID（空でよい）
  ['会議で共有', 'text'],  // v0.99.0：ミーティングで説明したい対応に「はい」（ミーティングの対応履歴で色が付く）
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
SCHEMA[SHEET_REPAIRS] = [
  ['修理ID', 'text'], ['顧客ID', 'text'], ['機器ID', 'text'], ['元の対応ID', 'text'], ['受付日', 'date'],
  ['完了日', 'date'], ['ステータス', 'text'], ['種別', 'text'], ['預かり品', 'text'], ['型番', 'text'],
  ['シリアル', 'text'], ['先方担当者', 'text'], ['担当スタッフ', 'text'], ['件名', 'text'], ['内容', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
SCHEMA[SHEET_MAINT] = [
  ['実施ID', 'text'], ['顧客ID', 'text'], ['機器ID', 'text'], ['実施日', 'date'], ['種別', 'text'], ['担当スタッフ', 'text'],
  ['内容', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_MEMOS] = [
  ['メモID', 'text'], ['顧客ID', 'text'], ['本文', 'text'], ['作成者', 'text'], ['ピン留め', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_NOTICES] = [
  ['お知らせID', 'text'], ['顧客ID', 'text'], ['本文', 'text'], ['重要度', 'text'], ['掲載期限', 'date'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
// Windows Update・ドライバーの不具合などの情報。スタッフの画面と、お客様ページのいちばん上に出す
SCHEMA[SHEET_WININFO] = [
  ['情報ID', 'text'], ['日付', 'date'], ['種類', 'text'], ['重要度', 'text'], ['タイトル', 'text'], ['内容', 'text'], ['リンク', 'text'],
  ['顧客に見せる', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
// Windows の便利機能（Tips）。RSS・Tips.gs の新しい文から足される。シートで直接、直す・消す・足すこともできる
SCHEMA[SHEET_TIPS] = [
  ['TipID', 'text'], ['見出し', 'text'], ['説明', 'text'], ['有効', 'text'], ['登録日時', 'datetime']
];
SCHEMA[SHEET_ATTACH] = [
  ['添付ID', 'text'], ['顧客ID', 'text'], ['ファイル名', 'text'], ['DriveファイルID', 'text'], ['サイズ', 'number'], ['種類', 'text'],
  ['お客様に見せる', 'text'], ['登録者', 'text'], ['登録日時', 'datetime'],
  // 記録（対応・修理・機器）に付けた写真のときだけ入る。サムネイルは、一覧に出す小さい画像（data:image/jpeg;base64,…）
  ['対象区分', 'text'], ['対象ID', 'text'], ['サムネイル', 'text'],
  // 付けた人のスタッフID（v0.20.0。表示名でなくIDで本人を見分ける。前からある行は空＝表示名で見分ける）
  ['登録者ID', 'text']
];
// 図形は、画面が作る要素の一覧をJSONにして1セルに入れる（中身の検査は Files.gs の sanitizeLayoutElements_）
SCHEMA[SHEET_LAYOUTS] = [
  ['レイアウトID', 'text'], ['顧客ID', 'text'], ['名前', 'text'], ['背景色', 'text'], ['画像ファイルID', 'text'], ['図形', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_RENTALS] = [
  ['レンタルID', 'text'], ['名称', 'text'], ['種類', 'text'], ['メーカー', 'text'], ['機種名', 'text'], ['シリアル', 'text'],
  ['状態', 'text'], ['用途', 'text'], ['購入日', 'date'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
SCHEMA[SHEET_LOANS] = [
  ['貸出ID', 'text'], ['レンタルID', 'text'], ['顧客ID', 'text'], ['貸出先', 'text'], ['貸出日', 'date'], ['返却予定日', 'date'],
  ['返却日', 'date'], ['担当スタッフ', 'text'], ['修理ID', 'text'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ひとこと', 'text']
];
// 開発案件（テスト版）。お客様ごとに作っている GAS・AppSheet・スプレッドシートのWebアプリの進捗
SCHEMA[SHEET_PROJECTS] = [
  ['案件ID', 'text'], ['案件名', 'text'], ['顧客ID', 'text'], ['種類', 'text'], ['状態', 'text'], ['進捗', 'number'],
  ['開始日', 'date'], ['納期', 'date'], ['金額', 'number'], ['担当', 'text'], ['次にやること', 'text'],
  ['先方名', 'text'], ['先方担当者', 'text'], ['電話', 'text'], ['メール', 'text'], ['確度', 'number'], ['次の連絡日', 'date'], ['失注理由', 'text'],
  ['スプレッドシートURL', 'text'], ['GASのURL', 'text'], ['WebアプリのURL', 'text'], ['AppSheetのURL', 'text'],
  ['備考', 'text'], ['お客様に見せる', 'text'], ['商談ID', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime'],
  ['ひとこと', 'text']      // v0.103.0：一覧にカーソルを当てると吹き出しで出る短いメモ（200文字まで）
];
// 商談（v0.81.0 のテスト版のシート）。v0.82.0 で開発案件に統合した。初期設定のとき、中身を開発案件へ移すためだけに残す
SCHEMA[SHEET_DEALS] = [
  ['商談ID', 'text'], ['見込み客名', 'text'], ['顧客ID', 'text'], ['先方担当者', 'text'], ['電話', 'text'], ['メール', 'text'],
  ['状態', 'text'], ['確度', 'number'], ['金額', 'number'], ['次の連絡日', 'date'], ['担当', 'text'], ['内容', 'text'],
  ['失注理由', 'text'], ['案件ID', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
// 営業活動のログ（テスト版）。訪問・電話・メールの記録と、次回アクション
SCHEMA[SHEET_SALESLOGS] = [
  ['営業ID', 'text'], ['日付', 'date'], ['区分', 'text'], ['商談ID', 'text'], ['顧客ID', 'text'], ['相手先', 'text'],
  ['内容', 'text'], ['次回アクション', 'text'], ['次回予定日', 'date'], ['アクション完了', 'text'], ['担当', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime'], ['案件ID', 'text']
];
// 要対応アラートの状態（通知したか、対応済みにしたか）。毎朝の処理が、いま出ているアラートに合わせて行を足し引きする
SCHEMA[SHEET_ALERTS] = [
  ['キー', 'text'], ['カテゴリ', 'text'], ['顧客ID', 'text'], ['対象ID', 'text'], ['判定値', 'text'],
  ['初回検知日時', 'datetime'], ['通知日時', 'datetime'], ['対応済み日時', 'datetime'], ['対応者', 'text']
];
SCHEMA[SHEET_AUDIT] = [
  ['日時', 'datetime'], ['種別', 'text'], ['対象', 'text'], ['顧客ID', 'text'], ['項目', 'text'],
  ['変更前', 'text'], ['変更後', 'text'], ['実行者', 'text']
];

// 初期設定で作る順番（＝スプレッドシートのタブの並び）
const SHEET_ORDER = [
  SHEET_CUSTOMERS, SHEET_DEVICES, SHEET_DIAGNOSTICS, SHEET_ACTIVITIES, SHEET_REPAIRS, SHEET_MAINT, SHEET_LICENSES, SHEET_ALLOCATIONS,
  SHEET_CREDENTIALS, SHEET_MEMOS, SHEET_NOTICES, SHEET_ATTACH, SHEET_LAYOUTS, SHEET_RENTALS, SHEET_LOANS,
  SHEET_PROJECTS, SHEET_SALESLOGS,
  SHEET_WININFO, SHEET_TIPS, SHEET_OPTIONS, SHEET_STAFF, SHEET_SETTINGS, SHEET_ALERTS, SHEET_AUDIT
];

// ---------------------------------------------------------------------------
// 固定の選択肢（処理の分かれ目になるので、選択肢シートでは変えられないようにしている）
// ---------------------------------------------------------------------------
const YES = 'はい';
const NO = 'いいえ';
const ROLE_ADMIN = '管理者';
const ROLE_STAFF = 'スタッフ';
const ROLES = [ROLE_ADMIN, ROLE_STAFF];
const CONTRACT_TYPES = ['定期保守', 'スポット保守', 'なし'];
const CUSTOMER_STATES = ['有効', '停止'];
const DEVICE_STATES = ['使用中', '未使用', '廃棄'];
const ACTIVITY_STATUSES = ['完了', '対応中'];      // v0.64.0：「保留中」は廃止
const ACTIVITY_HOLD = '対応中';     // 新しく記録するときの、最初のステータス
const ACTIVITY_DONE = '完了';
const REPAIR_STATUSES = ['受付', '対応中', '完了'];   // v0.64.0：「実施中」→「対応中」、「保留中」は廃止
// 古い名前 → 新しい名前（初期設定で、シートの値を書き換える）
/** v0.125.0：列の名前を変えたもの（初期設定で、シートの見出しを書き換える。値はそのまま） */
const HEADER_RENAMES = {};
HEADER_RENAMES[SHEET_CUSTOMERS] = { '年間保守料金': '月額保守料金' };
const STATUS_RENAMES = { activity: { '保留中': '対応中' }, repair: { '実施中': '対応中', '保留中': '対応中' } };
const REPAIR_DONE = '完了';
const CREDENTIAL_TARGETS = ['機器', 'ライセンス', 'その他'];
const PORTAL_TABS = ['機器', 'ライセンス', '修理', '対応', 'レイアウト', '資料', 'レポート', '開発'];
// タブではないが、顧客ごとに出す・出さないを選ぶもの（「ポータル表示」に、タブと並べて入れる）
const PORTAL_PRINT = '印刷ボタン';
const PORTAL_EXTRAS = [PORTAL_PRINT];
const RENTAL_STATES = ['利用可能', '修理中', '廃棄'];
const RENTAL_AVAILABLE = '利用可能';
// 開発案件・商談・営業活動（テスト版。v0.81.0）
const PROJECT_KINDS = ['GAS', 'AppSheet', 'スプレッドシート', 'GAS+AppSheet', 'その他'];
// 案件の状態：営業から開発まで1本（v0.82.0）。営業の段階 → 開発の段階 → 納品後
const PROJECT_STATES = ['問い合わせ', '提案中', '見積', '要件確認', '開発中', 'テスト', '納品済', '保守中', '保留', '失注'];
const PROJECT_SALES = ['問い合わせ', '提案中', '見積'];            // 営業の段階（顧客がまだ決まっていなくてよい。次の連絡日を見る）
const PROJECT_FIRST = PROJECT_SALES[0];
const PROJECT_ORDERED = '要件確認';                                // 受注して、開発に入る最初の状態
const PROJECT_ACTIVE = ['見積', '要件確認', '開発中', 'テスト'];    // 納期のアラートを出す状態（足した状態も、ここに入らないものは出さない）
const PROJECT_DELIVERED = '納品済';
const PROJECT_LOST = '失注';
const PROJECT_HOLD = '保留';
const PROJECT_MAINTAIN = '保守中';
const DEAL_WON = '受注';
const SALES_KINDS = ['訪問', '電話', 'メール', 'オンライン', 'その他'];
const NOTICE_LEVELS = ['通常', '重要'];
const WININFO_KINDS = ['更新プログラム', 'ドライバー', 'その他'];
const WININFO_SHOW_DAYS = 45;            // いちばん上に出すのは、日付がこの日数以内のもの
const WININFO_SHOW_MAX = 5;              // いちばん上に出す件数
const WININFO_PIN_PROPERTY = 'WININFO_PINS';   // ピン留めした Windows情報のID（スクリプトのプロパティ。シートの列は増やさない。v0.33.0）
const WININFO_PIN_MAX = 10;
const WININFO_TIDY_MAX = 200;            // 毎朝の片づけで、1回に消す行数の上限（v0.34.0）
const TIPS_MAX = 300;                    // Tips の件数の上限
const TIPS_TITLE_MAX = 40;
const TIPS_BODY_MAX = 120;
const WININFO_IMPORT_MAX = 50;           // 1回の貼り付けで取り込む行数
const WININFO_LINK = /^https:\/\/[^\s"'<>\\]{4,290}$/;
const MAINT_KIND_REGULAR = '定期保守';   // 「今月の定期保守」の集計で数える種別

// 添付とレイアウト図（Files.gs）
const FILES_FOLDER_NAME = 'PC管理パッケージのファイル';
const FILES_FOLDER_PROPERTY = 'FILES_FOLDER_ID';
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
// 記録に付ける写真。画面が小さくしてから送ってくる（長い辺1600px・JPEG）。ここは、送られてくる大きさの上限
const PHOTO_MAX_BYTES = 1536 * 1024;
const PHOTO_THUMB_MAX_CHARS = 24000;     // サムネイル（data URL）の長さの上限
const SCAN_PDF_MAX_BYTES = 10 * 1024 * 1024; // 書類のスキャンを1つのPDFにまとめたもの（v0.30.0）
const SCAN_PDF_MAX_PAGES = 15;
const REPORT_PUB_PREFIX = 'rpub_';           // 月次レポートを公開した月（スクリプトのプロパティ。rpub_<顧客ID>_<yyyy-MM> で1か月1つ）
const REPORT_NOTE_MAX = 300;               // 月次レポートの「ひとこと」の文字数
const PHOTO_MAX_PER_RECORD = 12;         // 1つの記録に付けられる枚数
// 写真を付けられる記録の種類 → [シート, IDの列, 対象区分に入れる名前]
const PHOTO_TARGETS = {
  activity: [SHEET_ACTIVITIES, '対応ID', '対応'],
  repair: [SHEET_REPAIRS, '修理ID', '修理'],
  device: [SHEET_DEVICES, '機器ID', '機器'],
  license: [SHEET_LICENSES, 'ライセンスID', 'ライセンス'],
  maintenance: [SHEET_MAINT, '実施ID', '保守'],          // v0.15.0 保守の報告書（紙）を撮って付ける
  memo: [SHEET_MEMOS, 'メモID', '社内メモ'],              // v0.103.0 社内メモに、写真・PDF・Excelなどのファイルを付ける
  project: [SHEET_PROJECTS, '案件ID', '案件'],            // v0.116.0 案件に、見積書・仕様書などを付ける
  saleslog: [SHEET_SALESLOGS, '営業ID', '営業']           // v0.116.0 営業の記録に、名刺・資料などを付ける
};
// 会社のロゴ。画面が小さくしてから送ってくる（data URL）。設定シートの1セルに入れる
// スタッフごとに覚える画面の状態（絞り込み・並び替え・期間の種類）。スタッフのシートの「画面設定」に JSON で入れる
const VIEW_STATE_MAX_CHARS = 6000;
const VIEW_PERIOD_MODES = ['week', 'month', 'range', 'all'];
const LOGO_SETTING_KEY = 'ロゴ画像';
const LOGO_MAX_CHARS = 45000;
const DATA_URL_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+={0,2})$/;
// 拡張子 → 受け付けるMIMEタイプ。ここに無い拡張子（exe・html・svg・js など）は受け付けない
const ATTACH_TYPES = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'],
  txt: ['text/plain'], csv: ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  doc: ['application/msword'], xls: ['application/vnd.ms-excel'], ppt: ['application/vnd.ms-powerpoint'],
  zip: ['application/zip', 'application/x-zip-compressed']
};
const LAYOUT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const LAYOUT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const LAYOUT_MAX_ELEMENTS = 400;
const LAYOUT_MAX_JSON = 48000;            // 1セルに入る文字数（5万）より少し手前
const LAYOUT_MAX_PER_CUSTOMER = 20;
const LAYOUT_BOX_TYPES = ['rect', 'circle', 'desk', 'chair', 'shelf', 'rack', 'counter', 'copier'];
const LAYOUT_LINE_TYPES = ['line', 'arrow'];
const LAYOUT_POLY_MAX_POINTS = 20;        // 折れ線1本の点の数
// 幹線図（v0.71.0）：ネットワーク機器の記号（net）と、記号どうしをつなぐ回線（link）
const LAYOUT_NET_KINDS = ['onu', 'router', 'fw', 'hub', 'ap', 'nas', 'server', 'mfp', 'port'];
const LAYOUT_LINK_KINDS = ['wan', 'trunk', 'lan', 'wifi'];
const LAYOUT_ICONS = ['🖨️', '📠', '📡', '🗄️', '💾', '☎️', '📺', '🚪', '🪟', '🔌', '🪴', '🚻'];
const AUDIT_VIEW_MAX = 500;
const PORTAL_TABS_DEFAULT = '機器,ライセンス,修理';
const REPAIR_ITEM_SUGGESTIONS = ['本体', 'AC電源', 'カバン', 'マウス'];

// ---------------------------------------------------------------------------
// 収集ツール（PCInfoTool）の受信
// ---------------------------------------------------------------------------
// [ツールが送る項目名, 機器診断シートの列, 型, 最大の文字数]
const DIAG_MAP = [
  ['シリアル', 'シリアル', 'text', 100],
  ['メーカー名', 'メーカー（取得値）', 'text', 100],
  ['機種名', '機種名（取得値）', 'text', 100],
  ['コンピューター名', 'コンピューター名', 'text', 60],
  ['IPアドレス', 'IPアドレス', 'text', 60],
  ['OS', 'OS', 'text', 100],
  ['CPU', 'CPU', 'text', 100],
  ['メモリ', 'メモリ', 'text', 40],
  ['SSD/HDD', 'ストレージ', 'longtext', 4000],
  ['イベント重大', 'イベント重大', 'number', 0],
  ['イベント重大（内容）', 'イベント重大（内容）', 'longtext', 8000],
  ['イベントエラー', 'イベントエラー', 'number', 0],
  ['イベントエラー（内容）', 'イベントエラー（内容）', 'longtext', 8000],
  ['ディスク関連イベント', 'ディスク関連イベント', 'longtext', 4000],
  ['プリンター情報', 'プリンター情報', 'longtext', 6000],
  ['BitLocker暗号化状況', 'BitLocker', 'longtext', 2000],
  ['Windows Update状況', 'Windows Update', 'longtext', 2000],
  ['ウイルス対策ソフト', 'ウイルス対策ソフト', 'longtext', 1000],
  ['バッテリー状態', 'バッテリー状態', 'longtext', 500],
  ['稼働時間', '稼働時間', 'longtext', 200],
  ['クラッシュダンプ', 'クラッシュダンプ', 'longtext', 500],
  ['前回メンテナンス', '前回メンテナンス', 'longtext', 500],
  ['ツールバージョン', 'ツールバージョン', 'text', 20],
  // v0.25.0
  ['スタートアップ', 'スタートアップ', 'longtext', 4000],
  ['前回との比較', '前回との比較', 'longtext', 2000],
  ['Cドライブ空き', 'Cドライブ空き', 'text', 20]
];
// 収集ツールのレポート（HTML）を受けて、機器に貼り付ける（v0.25.0）
const REPORT_TARGET_LABEL = '収集レポート';   // 添付シートの「対象区分」
const REPORT_MAX_BYTES = 1500000;
const REPORT_MAX_CHARS = 2100000;           // レポートの送信の上限（base64 で大きくなる分）
const REPORT_KEEP_PER_DEVICE = 3;           // 1台に残すレポートの数（古いものから消す）
// ツールが取ってくるメーカー名 → 選択肢の値（含まれていれば当てはめる。上から順に見る）
const MAKER_ALIASES = [
  ['hewlett', 'HP'], ['hp', 'HP'], ['dell', 'Dell'], ['alienware', 'Dell'], ['lenovo', 'Lenovo'], ['nec', 'NEC'],
  ['fujitsu', '富士通'], ['富士通', '富士通'], ['dynabook', 'Dynabook'], ['toshiba', 'Dynabook'], ['東芝', 'Dynabook'],
  ['mouse', 'マウスコンピューター'], ['apple', 'Apple'], ['asus', 'ASUS'], ['microsoft', 'Microsoft'],
  ['panasonic', 'パナソニック'], ['vaio', 'VAIO'], ['iiyama', 'iiyama']
];
// 機器を見分けるのに使えないシリアル（自作機や取得失敗で入ってくる決まり文句）
const JUNK_SERIAL = /^(取得失敗|不明|未確認|none|n\/a|unknown|default string|system serial number|chassis serial number|not (specified|applicable|available)|invalid|oem|o\.e\.m\.|to be filled.*|0+|1234567890?|x+|demo|03000200-0400-0500-0006-000700080009|0{8}-0{4}-.*|f{8}-f{4}-.*)$/i;   // v0.110.0：仮のシリアル・UUID を足した
const BACKUP_KEEP = 7;                       // バックアップを残す数（新しい順。これより古いものはごみ箱へ。v0.97.0）
const BACKUP_TRIGGER_FUNCTION = 'runDailyBackup';
const BACKUP_HOUR = 3;                      // 毎日のバックアップの時刻（3時台）
const BACKUP_STATUS_PROPERTY = 'BACKUP_STATUS';
const SHEET_AUDIT_ARCHIVE = '変更履歴_退避';   // 古い変更履歴の移し先（メニューから移したときに作る。SHEET_ORDER には入れない）
const SHEET_ACTIVITIES_ARCHIVE = '対応履歴_退避';   // 古い対応履歴の移し先（メニューから移したときに作る。v0.112.0）
const ACTIVITY_KEEP_DAYS = 365;             // 完了した対応履歴をシートに残す日数。これより古いものを「対応履歴_退避」へ移せる
const AUDIT_KEEP_DAYS = 365;                // 変更履歴をシートに残す日数。これより古いものを「変更履歴_退避」へ移せる
const FORMAT_MARK_PREFIX = 'fmt_';          // 空き行の書式を付けた印の、プロパティ名の頭（v0.97.0）
const CHANGES_MARGIN_MIN = 30;              // 新着だけ読み込むとき、取りこぼさないようにさかのぼる分（v0.67.0）
const RECEIVE_MAX_CHARS = 300000;        // 1回の送信の上限（文字数）
const PENDING_CUSTOMER_NAME = '仮受付（未割り当て）';   // トークンなしで届いたPCを入れる顧客（v0.64.0）
const PENDING_MAX_PER_10MIN = 60;       // トークンなしの受付：全体で10分間に受け付ける回数
const PENDING_MAX_NEW_PER_6H = 30;      // トークンなしの受付：6時間に新しく作る機器の数
const RECEIVE_MAX_PER_10MIN = 300;       // 1顧客あたり、10分間に受け付ける回数

// 選択肢シートで増やせる区分と、最初に入れておく値
const OPTION_DEFAULTS = {
  '機器種類': ['ノート', 'デスクトップ', 'タブレット', 'サーバー', 'NAS', 'プリンター', 'ネットワーク機器', 'その他'],
  'メーカー': ['HP', 'Dell', 'Lenovo', 'NEC', '富士通', 'Dynabook', 'マウスコンピューター', 'Apple', 'ASUS',
    'Microsoft', 'パナソニック', 'VAIO', 'iiyama', 'その他'],
  '購入元': ['自社', 'その他'],
  // ライセンスの製品マスター（v0.103.0）。ライセンスの「製品名」を入れるときの候補。設定の「選択肢」で足せる
  'ライセンス製品': ['Microsoft 365 Business Basic', 'Microsoft 365 Business Standard', 'Microsoft 365 Apps for business', 'Microsoft Office Home & Business', 'Windows 11 Pro', 'Adobe Acrobat', 'ESET', 'Google Workspace', 'その他'],
  '受付方法': ['電話', 'メール', '訪問時', 'その他'],
  '対応種別': ['訪問', 'リモート', '電話', 'あいさつ'],
  'インシデント種別': ['設定依頼', '障害', '相談', 'その他'],
  '修理種別': ['修理', '設定', 'データ復旧'],
  '保守種別': ['定期保守', 'スポット保守', 'その他'],
  '地域': [],
  // 状態の選択肢（v0.82.0）。基本の値は OPTION_BASE にあり、ここには「あとから足した値」だけが入る
  '機器の状況': [], '対応のステータス': [], '修理のステータス': [], 'レンタルの状態': [], '案件の状態': [],
  '案件の種類': PROJECT_KINDS.slice(), '営業の区分': SALES_KINDS.slice(),
  // 対応を記録するときに、ひと押しで「内容」に入れられる文（40文字まで）
  '対応の定型文': [
    'Windows Updateを適用し、再起動して動作を確認。',
    'プリンタードライバーを入れ直し、テスト印刷を確認。',
    'メールの設定を見直し、送受信を確認。',
    'パスワードを再設定し、サインインを確認。',
    'ウイルス対策ソフトの状態と定義の更新を確認。',
    'ルーターを再起動し、ネットワークの接続を確認。',
    '共有フォルダーのアクセス権を設定。',
    '新しいPCの初期設定とデータ移行を実施。',
    '定期保守で全台を点検。異常なし。',
    '電話で操作方法をご案内。'
  ]
};
const OPTION_CATEGORIES = Object.keys(OPTION_DEFAULTS);
// 画面やアラートの動きに関わる基本の値。いつも先頭に出て、消す・使わないにはできない（足すことだけできる）
//   足した値の扱い：対応・修理は「未完了」、機器は「使用中と同じ」、レンタルは「貸し出せない」、案件は「開発の途中」
const OPTION_BASE = {
  '機器の状況': DEVICE_STATES,
  '対応のステータス': ACTIVITY_STATUSES,
  '修理のステータス': REPAIR_STATUSES,
  'レンタルの状態': RENTAL_STATES,
  '案件の状態': PROJECT_STATES
};

// 設定シートの項目  [キー, 既定値, 説明]
const SETTING_DEFAULTS = [
  ['自社名', '', '画面の見出しと、お客様ビューに出す社名'],
  ['開いた直後の画面', 'PC管理', 'ログインした直後に開く画面（PC管理・対応履歴・修理履歴・ライセンス・レンタル・案件・営業・ミーティング・お知らせ）。スタッフが自分で選んでいないときに使う'],
  ['ウェブアプリURL', '', 'デプロイしたウェブアプリのURL（.../exec）。お客様ビューのURLを作るのに使う'],
  ['ライセンス期限の手前日数', '30', '有効期限がこの日数以内になったライセンスと、機器のESET期限を「期限が近い」として出す'],
  ['保証期限の手前日数', '60', '保証期限がこの日数以内になった機器を「保証が切れる」として出す'],
  ['スタッフに認証情報を見せる', YES, '「いいえ」にすると、パスワード類を表示できるのは管理者だけになる'],
  ['通知先メール', '', '要対応の通知メールを送る先。複数は「,」で区切る（5件まで）。空なら送らない'],
  ['通知の時刻', '8', '毎朝の通知を送る時刻（0〜23時）。変えたらメニューの「毎朝の通知を設定」をやり直す'],
  ['イベントエラーのしきい値', '200', '収集ツールのイベントエラーがこの件数以上の機器を出す。0で出さない'],
  ['ディスク異常を出す', YES, '収集ツールがディスクの異常イベントを見つけた機器を出す'],
  ['収集ツール未受信の日数', '45', '収集ツールからこの日数届いていない機器を出す。0で出さない'],
  ['修理の長期化の日数', '7', '受付からこの日数たっても完了していない修理を出す。0で出さない'],
  ['対応の保留の日数', '7', '受付からこの日数たっても完了していない対応を出す。0で出さない'],
  ['リモート多発の回数', '5', '保守契約のある顧客で、今月の「リモート」がこの回数以上になったら出す。0で出さない'],
  ['訪問多発の回数', '10', '保守契約のある顧客で、今月の「訪問」がこの回数以上になったら出す。0で出さない'],
  ['スポット保守の確認日', '20', '毎月この日を過ぎても、今月の対応が無いスポット保守の顧客を出す。0で出さない'],
  ['要対応に出さない種類', '', '要対応に出さない種類（画面の「設定」で選ぶ。ここは直接さわらない）。全員の画面と通知メールから外れる'],
  ['アラートの再表示日数', '30', '「対応済み」にしたアラートを、状況が変わらなくても出し直すまでの日数。0で出し直さない'],
  ['レンタル機器を使う', YES, '「いいえ」にすると、レンタル機器の画面と返却のアラートを出さない'],
  ['レンタル返却の手前日数', '3', '返却予定日がこの日数以内になった貸出を出す（予定日を過ぎたものは常に出す）'],
  ['営業・案件ツール（テスト版）を使う', YES, '「いいえ」にすると、案件・営業の画面と、それらの要対応を出さない（テスト版）'],
  ['案件の納期の手前日数', '7', '開発案件の納期がこの日数以内になったものを要対応に出す（納期を過ぎたものは常に出す。テスト版）'],
  ['Tipsを出す', YES, 'Windowsの便利機能（Tips）を、管理画面とお客様ページのいちばん上に出す'],
  ['RSSで自動取得する', YES, '窓の杜・PC Watch・ITmedia・JPCERT/CC・IPA・Security NEXT・AKIBA PC Hotline! の RSS から、Windows情報を自動で取り込む。「いいえ」なら RSS は読まない'],
  ['RSSの言葉（不具合・ドライバー）', 'Windows,Windows Update,更新プログラム,KB5,不具合,既知の問題,障害,ドライバー,ドライバ,BIOS,ファームウェア,ブルースクリーン,起動しない,Microsoft 365,Office,Edge,Teams,OneDrive,Copilot', 'RSS の記事のタイトル・概要にこの言葉が入っていたら取り込む（Windows の不具合・ドライバー）。カンマ区切り。窓の杜・PC Watch・ITmedia PC USER で使う'],
  ['RSSの言葉（セキュリティ）', '脆弱性,セキュリティ,ゼロデイ,ランサムウェア,不正アクセス,マルウェア,注意喚起,CVE,悪用', 'RSS の記事のタイトル・概要にこの言葉が入っていたら取り込む（セキュリティ）。カンマ区切り。窓の杜・PC Watch・ITmedia・JPCERT・IPA・Security NEXT で使う'],
  ['RSSの言葉（PCパーツ）', '値上,高騰,価格改定,品薄,在庫,メモリ,DRAM,SSD,HDD,GPU,CPU,関税', 'RSS の記事のタイトル・概要にこの言葉が入っていたら取り込む（PCパーツの値上げ・在庫）。カンマ区切り。AKIBA・PC Watch・ITmedia PC USER で使う'],
  ['RSSの除外ワード', '', 'RSS の記事のタイトルにこの言葉が入っていたら取り込まない。カンマ区切り（例：ゲーム,iPhone）'],
  ['配信を確かめる間隔（時間）', '6', 'RSS を確かめる間隔（1〜6時間）'],
  ['RSSを止める媒体', '', '読まない媒体の名前（例：AKIBA,Security NEXT）。カンマ区切り。空なら全部読む'],
  ['RSSの追加URL', '', '自分で足したい RSS（https://…）。3つまで、カンマで区切る。記事は全部取り込む（RSS 2.0・RSS 1.0・Atom）'],
  ['Windows情報を取り込む', YES, 'RSS の Windows情報（不具合など）を取り込む。「いいえ」なら取り込まない'],
  ['Tipsを取り込む', YES, '新しい版の Tips を、Tips のシートに足す。「いいえ」なら足さない'],
  ['取り込んだWindows情報をお客様に見せる', NO, '「はい」なら、取り込んだ Windows情報をすぐお客様ページにも出す。「いいえ」は社内だけ（確かめてから見せる）'],
  ['Windows情報を残す日数', '365', '日付がこれ（日）より古い Windows情報を、毎朝の処理で消す。ピン留めしたものは消さない。0で消さない'],
  ['カレンダーID', '', 'ミーティングの「スケジュール」に出す Google カレンダーのID。いくつかあるときはカンマで区切る（10個まで）。空なら出さない（カレンダーの「設定と共有」→「カレンダーの統合」にあります）'],
  ['納品の予定に使う言葉', '納品,搬入,設置,キッティング', 'この言葉が予定名か説明に入っていれば、納品の予定として色を付け、台数を数える（カンマで区切る）'],
  ['カレンダーの表示名', '', 'ミーティングの「スケジュール」の見出しの横に出す名前（例：納品スケジュール）。空なら、Google カレンダーに付いている名前を出す'],
  ['納品以外の予定も出す', NO, '「いいえ」なら、ミーティングのスケジュールには納品の予定（上の言葉が入っているもの）だけを出す。「はい」なら、ほかの予定も出す'],
  ['スポット料金：訪問（円/回）', '10000', '保守のご報告書の「保守がなかったら」で、訪問1回をこの金額で数える'],
  ['スポット料金：リモート（円/回）', '3000', '同じく、リモート1回の金額'],
  ['スポット料金：電話（円/回）', '0', '同じく、電話1回の金額（0なら数えない）'],
  ['契約更新のお知らせ（日前）', '60', '顧客の「契約更新日」のこの日数前から、要対応に「保守のご報告書をお持ちする」を出す'],
  ['定期保守のカレンダーID', '', '定期保守の日程を入れる Google カレンダーのID。担当（ルート）ごとに分けるときは、カンマで区切っていくつでも（10個まで）。空なら日程の自動作成は使えない'],
  ['定期保守の1日の上限（社）', '3', '定期保守の日程を作るとき、1つのカレンダー（担当）で1日に回る社数の上限'],
  ['定期保守の10台あたりの時間（分）', '30', '1社にかける時間の目安。PC 10台ごとにこの時間（10台以下はこの時間）'],
  ['定期保守の開始時刻', '9:00', '定期保守の1日の始まり（例 9:00）'],
  ['定期保守の終了時刻', '17:00', '定期保守の1日の終わり（例 17:00）。この時刻までに終わる社だけ入れる'],
  ['定期保守の移動時間（分）', '30', '1社が終わってから、次の社を始めるまでの時間（移動・休み）'],
  ['トークンなしの仮受付', NO, '「はい」の間だけ、受信トークンなしの送信を受ける。届いたPCは顧客「仮受付（未割り当て）」に入る。済んだら「いいえ」に戻す'],
  ['レポートは公開した月だけ見せる', YES, 'お客様ページの月次レポート。「はい」は、顧客の画面の「レポート」で「お客様ページに出す」を押した月だけ。「いいえ」は、終わった月（過去12か月）を全部見せる'],
  ['添付をリンクで共有する', YES, '「はい」だと、添付はリンクを知っている人が見られる状態で保存する（お客様ページに出すには「はい」が必要）']
];
// 管理画面から変えられる設定のキーと、値の種類
// 開いた直後の画面に選べるもの。前の版の値（ダッシュボード・顧客の一覧）は、どちらも「PC管理」として扱う
const START_VIEWS = ['PC管理', '対応履歴', '修理履歴', 'ライセンス', 'レンタル', '案件・営業', 'ミーティング', 'お知らせ'];
const SETTING_TYPES = {
  '自社名': 'text',
  '開いた直後の画面': 'start',
  'ウェブアプリURL': 'url',
  'ライセンス期限の手前日数': 'days',
  'スポット料金：訪問（円/回）': 'count', 'スポット料金：リモート（円/回）': 'count', 'スポット料金：電話（円/回）': 'count',
  '契約更新のお知らせ（日前）': 'days',
  '保証期限の手前日数': 'days',
  'スタッフに認証情報を見せる': 'yesno',
  '通知先メール': 'emails',
  '通知の時刻': 'hour',
  'イベントエラーのしきい値': 'count',
  'ディスク異常を出す': 'yesno',
  '収集ツール未受信の日数': 'days',
  '修理の長期化の日数': 'days',
  '対応の保留の日数': 'days',
  'リモート多発の回数': 'count',
  '訪問多発の回数': 'count',
  'スポット保守の確認日': 'day',
  '要対応に出さない種類': 'cats',
  'アラートの再表示日数': 'days',
  'レンタル機器を使う': 'yesno',
  '営業・案件ツール（テスト版）を使う': 'yesno',
  '案件の納期の手前日数': 'days',
  'レンタル返却の手前日数': 'days',
  '添付をリンクで共有する': 'yesno',
  'Tipsを出す': 'yesno',
  'Windows情報を取り込む': 'yesno',
  'RSSで自動取得する': 'yesno',
  'RSSの言葉（不具合・ドライバー）': 'words',
  'RSSの言葉（セキュリティ）': 'words',
  'RSSの言葉（PCパーツ）': 'words',
  'RSSの除外ワード': 'words',
  '配信を確かめる間隔（時間）': 'count',
  'RSSを止める媒体': 'words',
  'RSSの追加URL': 'rssurl',
  'Tipsを取り込む': 'yesno',
  '取り込んだWindows情報をお客様に見せる': 'yesno',
  'Windows情報を残す日数': 'count',
  'トークンなしの仮受付': 'yesno',
  'レポートは公開した月だけ見せる': 'yesno',
  'カレンダーID': 'calids',
  '定期保守のカレンダーID': 'calids',
  '定期保守の1日の上限（社）': 'count',
  '定期保守の10台あたりの時間（分）': 'count',
  '定期保守の開始時刻': 'hm',
  '定期保守の終了時刻': 'hm',
  '定期保守の移動時間（分）': 'count',
  '納品以外の予定も出す': 'yesno',
  'カレンダーの表示名': 'text',
  '納品の予定に使う言葉': 'text'
};

// ---------------------------------------------------------------------------
// 要対応アラート  [カテゴリ, 画面に出す名前]。並びは出す順（上ほど先）
// ---------------------------------------------------------------------------
const ALERT_CATEGORIES = [
  ['pending', '仮受付（未割り当て）'],
  ['disk', 'ディスク異常'],
  ['license', 'ライセンス期限'],
  ['eset', 'ESET期限'],
  ['rental', 'レンタルの返却'],
  ['project', '案件の納期・連絡'],
  ['sales', '営業の次回アクション'],
  ['repair', '修理の長期化'],
  ['activity', '対応の保留'],
  ['event', 'イベントエラー多発'],
  ['stale', '収集ツール未受信'],
  ['frequent', 'リモート・訪問の多発'],
  ['spotidle', 'スポット保守の対応なし'],
  ['renewal', '保守契約の更新']           // v0.123.0
];
// 多発の判定で数える対応種別の名前（選択肢シートの値と同じにしておくこと）
const ACTIVITY_KIND_REMOTE = 'リモート';
const ACTIVITY_KIND_VISIT = '訪問';
const ALERT_TRIGGER_FUNCTION = 'runDailyAlerts';
const FEED_TRIGGER_FUNCTION = 'runFeedCheck';     // RSS を確かめる（1時間ごとに呼び、設定の間隔がたっていれば読む。v0.113.0）
// GAS を起こしておく（v0.21.0）。時間のトリガーで30分ごとに呼び、この時間帯だけ、控え（キャッシュ）を作っておく。
// しばらくだれも使わないと、最初に開く人のときに控えが切れていて遅くなるため
const WARM_TRIGGER_FUNCTION = 'runWarmUp';
const WARM_EVERY_MINUTES = 30;
const WARM_FROM_HOUR = 6;      // この時から
const WARM_TO_HOUR = 21;       // この時の前まで（6〜20時台。v0.48.0 で広げた）
const ALERT_MAIL_MAX_LINES = 60;

// ---------------------------------------------------------------------------
// 入力項目の定義（サーバーの入力チェックと、画面のフォームの両方がこれを使う）
//   type: text / longtext / date / datetime / number / select（固定の選択肢）/ option（選択肢シート）
//         / multi（固定の選択肢から複数）/ yesno / customer / device / staff / secret / rental（レンタル機器）/ project（開発案件）/ deal（商談）
//   quick: true … いつも出す項目（それ以外は「詳しい項目」にたたむ）。1つも無い種類は全部出す
//   chips: true … 選択肢が少ないときは、プルダウンでなく押しやすいボタンで出す
//   suggest     … 文字の入力欄に添える候補（押すと足す・外す）
// ---------------------------------------------------------------------------
const ENTITIES = {
  customer: {
    label: '顧客', sheet: SHEET_CUSTOMERS, idField: '顧客ID', prefix: 'C', digits: 4, nameField: '顧客名',
    fields: [
      { name: '顧客名', type: 'text', required: true, max: 100, quick: true },
      { name: 'ふりがな', type: 'text', max: 100, quick: true },
      { name: '保守契約', type: 'select', choices: CONTRACT_TYPES, required: true, def: 'なし', quick: true, chips: true },
      { name: '電話', type: 'text', max: 30, quick: true },
      { name: '先方担当者', type: 'text', max: 60, quick: true },
      { name: '郵便番号', type: 'text', max: 10 },
      { name: '住所', type: 'text', max: 200 },
      { name: '地域', type: 'option', category: '地域' },
      { name: 'メール', type: 'text', max: 120 },
      { name: '状態', type: 'select', choices: CUSTOMER_STATES, required: true, def: '有効' },
      { name: 'ポータル公開', type: 'yesno', adminOnly: true, def: NO },
      { name: 'ポータル表示', type: 'multi', choices: PORTAL_TABS.concat(PORTAL_EXTRAS), adminOnly: true, def: PORTAL_TABS_DEFAULT },
      { name: '契約更新日', type: 'date', hint: 'この日の手前で、要対応に「保守のご報告書をお持ちする」が出ます' },
      { name: '月額保守料金', type: 'number', max: 9999999, adminOnly: true, hint: '円（1か月あたり）。保守のご報告書で、12か月分を「スポットで頼んだ場合」と比べます' },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  device: {
    label: '機器', sheet: SHEET_DEVICES, idField: '機器ID', prefix: 'D', digits: 5, nameField: '機種名',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '種類', type: 'option', category: '機器種類', required: true, quick: true, chips: true },
      { name: '利用者', type: 'text', max: 60, quick: true },
      { name: 'メーカー', type: 'option', category: 'メーカー', quick: true },
      { name: '機種名', type: 'text', max: 100, quick: true },
      { name: 'シリアル', type: 'text', max: 60, quick: true },
      { name: '設置場所', type: 'text', max: 100, quick: true },
      { name: '状況', type: 'option', category: '機器の状況', required: true, def: '使用中', chips: true },
      { name: '部署', type: 'text', max: 100 },
      { name: 'ふりがな', type: 'text', max: 60 },
      { name: '購入日', type: 'date', label: 'キッティング日／購入日', hint: '購入元が自社（EN・GROW）ならキッティング日' },     // 画面の名前だけ変える（シートの列は「購入日」のまま。v0.113.0・v0.122.0）
      { name: '購入元', type: 'option', category: '購入元' },
      { name: '保証期限', type: 'date', hint: '購入元が自社で空なら、キッティング日から1年で自動で入ります（延長保証のときは入れてください）' },
      { name: 'ESET', type: 'date' },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  license: {
    label: 'ライセンス', sheet: SHEET_LICENSES, idField: 'ライセンスID', prefix: 'L', digits: 4, nameField: '製品名',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '製品名', type: 'text', required: true, max: 100, quick: true, master: 'ライセンス製品' },
      { name: '数量', type: 'number', max: 100000, quick: true },
      { name: '有効期限', type: 'date', quick: true },
      { name: '契約期間', type: 'text', max: 40 },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 },
      { name: '不使用', type: 'yesno', def: NO }
    ]
  },
  activity: {
    label: '対応履歴', sheet: SHEET_ACTIVITIES, idField: '対応ID', prefix: 'A', digits: 6, nameField: '内容',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '機器ID', type: 'device', quick: true },
      { name: '受付方法', type: 'option', category: '受付方法', quick: true, chips: true },
      { name: '対応種別', type: 'option', category: '対応種別', required: true, quick: true, chips: true },
      { name: 'インシデント種別', type: 'option', category: 'インシデント種別', quick: true, chips: true },
      { name: '内容', type: 'longtext', required: true, max: 5000, quick: true },
      { name: '案件ID', type: 'project' },
      { name: 'ステータス', type: 'option', category: '対応のステータス', required: true, def: ACTIVITY_HOLD, quick: true, chips: true },
      // v0.133.0：担当（受付スタッフ）と開始日時は、いつも出す。開始日時は、新しく記録するとき今の日時が入る。
      //   完了日時は「詳しい項目」へ（ステータスを完了にすると、自動で今の日時が入る）
      { name: '受付スタッフ', type: 'staff', def: 'me', quick: true },
      { name: '開始日時', type: 'datetime', quick: true },
      { name: '受付日', type: 'date', required: true, def: 'today' },
      { name: '完了日時', type: 'datetime' },
      { name: '先方担当者', type: 'text', max: 60 },
      { name: 'ピン留め', type: 'yesno', def: NO },
      { name: '会議で共有', type: 'yesno', def: NO },
      { name: 'ひとこと', type: 'text', max: 200 }
    ]
  },
  repair: {
    label: '修理案件', sheet: SHEET_REPAIRS, idField: '修理ID', prefix: 'R', digits: 5, nameField: '件名',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '機器ID', type: 'device', quick: true },
      { name: '種別', type: 'option', category: '修理種別', required: true, quick: true, chips: true },
      { name: '件名', type: 'text', required: true, max: 100, quick: true },
      { name: '預かり品', type: 'text', max: 200, quick: true, suggest: REPAIR_ITEM_SUGGESTIONS },
      // v0.133.0：型番・シリアル・担当は、いつも出す（機器を選ぶと、型番とシリアルは台帳から入る）
      { name: '型番', type: 'text', max: 100, quick: true },
      { name: 'シリアル', type: 'text', max: 60, quick: true },
      { name: '内容', type: 'longtext', max: 5000, quick: true },
      { name: 'ステータス', type: 'option', category: '修理のステータス', required: true, def: '受付', quick: true, chips: true },
      { name: '担当スタッフ', type: 'staff', def: 'me', quick: true },
      { name: '受付日', type: 'date', required: true, def: 'today' },
      { name: '完了日', type: 'date' },
      { name: '元の対応ID', type: 'text', max: 20, ref: 'activity' },
      { name: '先方担当者', type: 'text', max: 60 },
      { name: 'ひとこと', type: 'text', max: 200 }
    ]
  },
  maintenance: {
    label: '保守実施', sheet: SHEET_MAINT, idField: '実施ID', prefix: 'M', digits: 5, nameField: '種別',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '実施日', type: 'date', required: true, def: 'today', quick: true },
      { name: '種別', type: 'option', category: '保守種別', required: true, quick: true, chips: true },
      { name: '内容', type: 'longtext', max: 5000, quick: true },
      { name: '機器ID', type: 'device' },
      { name: '担当スタッフ', type: 'staff', def: 'me' }
    ]
  },
  memo: {
    label: '社内メモ', sheet: SHEET_MEMOS, idField: 'メモID', prefix: 'N', digits: 5, nameField: '本文',
    fields: [
      { name: '顧客ID', type: 'customer', quick: true },
      { name: '本文', type: 'longtext', required: true, max: 3000, quick: true },
      { name: 'ピン留め', type: 'yesno', def: NO, quick: true },
      { name: '作成者', type: 'staff', def: 'me' }
    ]
  },
  notice: {
    label: 'お知らせ', sheet: SHEET_NOTICES, idField: 'お知らせID', prefix: 'I', digits: 4, nameField: '本文',
    fields: [
      { name: '顧客ID', type: 'customer', quick: true },
      { name: '本文', type: 'longtext', required: true, max: 1000, quick: true },
      { name: '重要度', type: 'select', choices: NOTICE_LEVELS, required: true, def: '通常', quick: true, chips: true },
      { name: '掲載期限', type: 'date', quick: true }
    ]
  },
  wininfo: {
    label: 'Windows情報', sheet: SHEET_WININFO, idField: '情報ID', prefix: 'W', digits: 4, nameField: 'タイトル',
    fields: [
      { name: '日付', type: 'date', required: true, def: 'today', quick: true },
      { name: '種類', type: 'select', choices: WININFO_KINDS, required: true, def: WININFO_KINDS[0], quick: true, chips: true },
      { name: '重要度', type: 'select', choices: NOTICE_LEVELS, required: true, def: '通常', quick: true, chips: true },
      { name: 'タイトル', type: 'text', required: true, max: 60, quick: true },
      { name: '内容', type: 'longtext', max: 300, quick: true },
      { name: 'リンク', type: 'text', max: 300, quick: true },
      { name: '顧客に見せる', type: 'yesno', def: YES, quick: true }
    ]
  },
  rental: {
    label: 'レンタル機器', sheet: SHEET_RENTALS, idField: 'レンタルID', prefix: 'RT', digits: 4, nameField: '名称',
    fields: [
      { name: '名称', type: 'text', required: true, max: 100, quick: true },
      { name: '種類', type: 'option', category: '機器種類', quick: true, chips: true },
      { name: '状態', type: 'option', category: 'レンタルの状態', required: true, def: RENTAL_AVAILABLE, quick: true, chips: true },
      { name: '用途', type: 'text', max: 60, quick: true },
      { name: 'メーカー', type: 'option', category: 'メーカー' },
      { name: '機種名', type: 'text', max: 100 },
      { name: 'シリアル', type: 'text', max: 60 },
      { name: '購入日', type: 'date' },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  loan: {
    label: '貸出記録', sheet: SHEET_LOANS, idField: '貸出ID', prefix: 'LN', digits: 5, nameField: 'レンタルID',
    fields: [
      { name: 'レンタルID', type: 'rental', required: true, quick: true },
      { name: '顧客ID', type: 'customer', quick: true },
      { name: '貸出先', type: 'text', max: 100, quick: true },
      { name: '貸出日', type: 'date', required: true, def: 'today', quick: true },
      { name: '返却予定日', type: 'date', quick: true },
      { name: '返却日', type: 'date', quick: true },
      { name: '担当スタッフ', type: 'staff', def: 'me' },
      { name: '修理ID', type: 'text', max: 20 },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  project: {
    label: '案件', sheet: SHEET_PROJECTS, idField: '案件ID', prefix: 'PJ', digits: 4, nameField: '案件名',
    fields: [
      { name: '案件名', type: 'text', required: true, max: 100, quick: true },
      { name: '顧客ID', type: 'customer', quick: true },
      { name: '種類', type: 'option', category: '案件の種類', def: 'GAS', quick: true, chips: true },
      { name: '状態', type: 'option', category: '案件の状態', required: true, def: PROJECT_FIRST, quick: true, chips: true },
      { name: '次の連絡日', type: 'date', quick: true },
      { name: '納期', type: 'date', quick: true },
      { name: '担当', type: 'staff', def: 'me', quick: true },
      { name: '次にやること', type: 'text', max: 200, quick: true },
      { name: '先方担当者', type: 'text', max: 60 },
      { name: '電話', type: 'text', max: 30 },
      { name: 'メール', type: 'text', max: 120 },
      { name: '開始日', type: 'date' },
      { name: 'スプレッドシートURL', type: 'text', max: 300 },
      { name: 'WebアプリのURL', type: 'text', max: 300 },
      { name: 'お客様に見せる', type: 'yesno', def: NO },
      { name: '失注理由', type: 'text', max: 200 },
      { name: 'ひとこと', type: 'text', max: 200 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  saleslog: {
    label: '営業活動', sheet: SHEET_SALESLOGS, idField: '営業ID', prefix: 'SL', digits: 5, nameField: '内容',
    fields: [
      { name: '日付', type: 'date', required: true, def: 'today', quick: true },
      { name: '区分', type: 'option', category: '営業の区分', required: true, def: SALES_KINDS[0], quick: true, chips: true },
      { name: '案件ID', type: 'project', quick: true },
      { name: '顧客ID', type: 'customer', quick: true },
      { name: '相手先', type: 'text', max: 100, quick: true },
      { name: '内容', type: 'longtext', required: true, max: 2000, quick: true },
      { name: '次回アクション', type: 'text', max: 200, quick: true },
      { name: '次回予定日', type: 'date', quick: true },
      { name: 'アクション完了', type: 'yesno', def: NO },
      { name: '担当', type: 'staff', def: 'me' }
    ]
  },
  credential: {
    label: '認証情報', sheet: SHEET_CREDENTIALS, idField: '認証ID', prefix: 'K', digits: 5, nameField: '名称',
    fields: [
      { name: '顧客ID', type: 'customer', required: true },
      { name: '対象区分', type: 'select', choices: CREDENTIAL_TARGETS, required: true, def: 'その他', chips: true },
      { name: '対象ID', type: 'text', max: 20 },
      { name: '名称', type: 'text', required: true, max: 100 },
      { name: 'ログインID', type: 'text', max: 200 },
      { name: 'パスワード', type: 'secret', max: 200 },
      { name: 'シリアルキー', type: 'secret', max: 300 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  }
};

// 上限
const PHONE_ACT_DAYS = 90;                // スマホに最初に渡す対応履歴：完了していないものと、この日数以内のもの（v0.132.0）
const MAX_ACTIVITIES_IN_BOOTSTRAP = 1000; // 管理画面に最初に渡す対応履歴の件数（新しい順）
const PORTAL_ACTIVITY_LIMIT = 50;         // お客様ビューに出す対応履歴の件数
const SESSION_SECONDS = 21600;            // ログインの有効時間（6時間。CacheServiceの上限）
const LOGIN_MAX_FAILS = 5;                // この回数まちがえると一時的にログインできなくする
const LOGIN_LOCK_SECONDS = 600;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_HASH_ROUNDS = 300;
const REMEMBER_DAYS = 30;                 // 「ログインしたままにする」が効く日数
const REMEMBER_MAX_PER_STAFF = 5;         // 1人が同時に「ログインしたまま」にできる端末の数（超えたら古いものから切れる）
const REMEMBER_MAX_TOTAL = 300;           // 全員ぶんの上限

// ---------------------------------------------------------------------------
// 読み込みを速くするための控え（サーバー側のキャッシュ）。しくみは Cache.gs
// ---------------------------------------------------------------------------
// 控えを持っておく秒数（最長 21600）。0 にすると、控えを使わない（毎回シートを読む。v0.12.0 までと同じ動き）
const SERVER_CACHE_SECONDS = 21600;
const CACHE_CHUNK_CHARS = 30000;          // 1つの控えに入れる文字数（CacheService は1つ100KBまで。日本語は1文字3バイト）
const CACHE_MAX_CHUNKS = 20;              // 1つの部品を、いくつまでに分けて控えるか（これより大きい部品は控えない）
const CACHE_PUT_CHARS = 120000;           // 1回にまとめて入れる文字数
// 部品 → もとになるシート。ここに書いたシートにアプリが書くと、その部品の控えは作り直しになる
const CACHE_DEPS = {
  customers: [SHEET_CUSTOMERS],
  devices: [SHEET_DEVICES],
  diagnostics: [SHEET_DIAGNOSTICS],
  licenses: [SHEET_LICENSES],
  allocations: [SHEET_ALLOCATIONS],
  repairs: [SHEET_REPAIRS],
  activities: [SHEET_ACTIVITIES],
  maintenances: [SHEET_MAINT],
  memos: [SHEET_MEMOS],
  notices: [SHEET_NOTICES],
  rentals: [SHEET_RENTALS],
  loans: [SHEET_LOANS],
  projects: [SHEET_PROJECTS],
  saleslogs: [SHEET_SALESLOGS],
  photoCounts: [SHEET_ATTACH],
  wininfo: [SHEET_WININFO],
  // 要対応は、もとのシートごとに分けて持つ（設定のしきい値と、顧客の状態・保守契約は、どれにも効く）
  alertsLicense: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_LICENSES, SHEET_DEVICES],
  alertsRental: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_RENTALS, SHEET_LOANS],
  alertsDevice: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_DEVICES, SHEET_DIAGNOSTICS],
  alertsRepair: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_REPAIRS],
  alertsActivity: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_ACTIVITIES],
  alertsBiz: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_PROJECTS, SHEET_SALESLOGS],
  alertStates: [SHEET_ALERTS],
  // 参照の控え（v0.18.0。Cache.gs の refBuilders_）
  refSettings: [SHEET_SETTINGS],
  refOptions: [SHEET_OPTIONS],
  refStaff: [SHEET_STAFF]
};
// 部品ごとの控えの長さ（秒）。書いてない部品は SERVER_CACHE_SECONDS。
// スタッフは、シートで行を消した・別の方法で直した（onEdit が動かない）ときも、すぐ効くように短くする（v0.18.0）
const CACHE_TTL = { refStaff: 90 };
// 一覧と要対応の計算では読まない、機器診断の重い列（機器の詳細・お客様ページ・レポートでは読む）
const DIAG_LEAN_SKIP = ['イベントエラー（内容）', 'プリンター情報', 'BitLocker', 'Windows Update', 'ウイルス対策ソフト', 'バッテリー状態',
  '稼働時間', 'クラッシュダンプ', '前回メンテナンス', 'ツールバージョン', 'スタートアップ', '前回との比較'];

// =============================================================================
// ここから：元 Tips.gs（v0.93.0 でファイルをまとめた。中身は同じ）
// =============================================================================
/**
 * Tips.gs … Windows の便利機能（Tips）
 *
 * 管理画面とお客様ページのいちばん上に、1件ずつ出す。日替わりで変わる。
 * 設定の「Tipsを出す」を「いいえ」にすると、どちらにも出さない。
 *
 * ここにあるのは「最初に入れる文」。初期設定のときに Tips のシートへ入り、そのあとはシートのほうを使う
 * （新しい文は RSS の確認のときに足される。シートで直接、直す・消す・足すこともできる）。
 * 文は、短く・やさしく。[見出し, 説明]
 */
const WINDOWS_TIPS = [
  ['Win + V', 'コピーしたものの履歴から、選んで貼り付けられます。初回は「オンにする」を押します。'],
  ['Win + Shift + S', '画面の好きな範囲を切り取って、そのまま貼り付けられます。'],
  ['Win + ← / →', 'ウィンドウを、画面の左半分・右半分にぴったり並べられます。'],
  ['Win + D', '開いているウィンドウを一度に隠して、デスクトップを出します。もう一度押すと戻ります。'],
  ['Win + L', '席を離れるときは、これで画面をロック。のぞき見を防げます。'],
  ['Win + E', 'エクスプローラー（ファイルの画面）を、すぐ開けます。'],
  ['Win + .（ピリオド）', '絵文字や記号の一覧が出ます。「→」や「〒」もここから入れられます。'],
  ['Win + I', '設定の画面を、すぐ開けます。'],
  ['Win + 数字', 'タスクバーの左から数えた順番のアプリを、すぐ開けます。'],
  ['Win + P', 'プロジェクターや外部モニターへの映し方（複製・拡張）を切り替えられます。'],
  ['Win + Shift + ← / →', 'ウィンドウを、もう1台のモニターへ移せます。'],
  ['Win + H', '声で文字を入力できます。長い文章の下書きに便利です。'],
  ['Win + PrintScreen', '画面全体を画像で保存します。保存先は「ピクチャ」の中の「スクリーンショット」です。'],
  ['Win + +（プラス）', '拡大鏡が開いて、画面を大きく見られます。Win + Esc で終わります。'],
  ['Alt + Tab', '開いているウィンドウを、順に切り替えられます。'],
  ['Ctrl + Z / Ctrl + Y', '「元に戻す」と「やり直す」。ファイルをまちがえて消したときも、Ctrl + Z で戻せます。'],
  ['Ctrl + S', 'こまめに保存。作業の区切りごとに押す習慣を付けると安心です。'],
  ['Ctrl + F', 'ページや文書の中から、言葉を探せます。'],
  ['Ctrl + A', 'ファイルや文章を、全部まとめて選べます。'],
  ['Ctrl + P', '印刷の画面を開きます。プリンターに「PDFとして保存」を選べば、PDFにもできます。'],
  ['Ctrl + Shift + T', 'まちがえて閉じたブラウザのタブを、開き直せます。'],
  ['Ctrl + Shift + Esc', 'タスクマネージャーを開きます。固まったアプリを終了できます。'],
  ['Ctrl + マウスホイール', '文字が小さいときは、Ctrl を押しながらホイールを回すと拡大できます。'],
  ['Ctrl + クリック / Shift + クリック', 'Ctrl で1つずつ、Shift で範囲をまとめて、ファイルを選べます。'],
  ['F2', 'ファイルを選んで F2 を押すと、名前をすぐ変えられます。'],
  ['Tab', '入力欄の移動は Tab、戻るのは Shift + Tab。マウスに持ち替えずに済みます。'],
  ['エクスプローラーのタブ', 'Ctrl + T でタブを足せます。フォルダーをいくつも開くときに便利です。'],
  ['ファイルの場所をコピー', 'ファイルを選んで Ctrl + Shift + C を押すと、ファイルの場所（パス）をコピーできます。'],
  ['ファイル名に日付', 'ファイル名の頭に「20261004_」のように日付を付けると、並び順で探しやすくなります。'],
  ['拡張子を表示する', 'エクスプローラーの「表示」→「表示」→「ファイル名拡張子」。あやしいファイルに気づきやすくなります。'],
  ['夜間モード', '設定 → システム → ディスプレイ → 夜間モード。夕方からの目の疲れを減らせます。'],
  ['調子が悪いときは再起動', '動きが重い・おかしいときは、まず再起動。シャットダウンより、再起動のほうが効きます。'],
  ['更新して再起動', '「更新して再起動」が出ていたら、帰る前に実行を。更新をためると、不具合のもとになります。'],
  ['USBメモリーを抜く前に', '右下の「ハードウェアを安全に取り外す」を押してから抜くと、データの破損を防げます。'],
  ['Wi-Fi がつながらない', 'まず機内モードをオン→オフ。だめならPCを再起動。それでもだめなら、ルーターの電源を入れ直します。'],
  ['印刷できない', 'プリンターの電源を入れ直します。直らなければ、設定の「プリンターとスキャナー」で、止まっている印刷を消します。'],
  ['あやしいメール', '添付やリンクを開く前に、差出人のアドレスを確認。迷ったら、開かずに担当へ相談を。'],
  ['パスワード', '使い回しは禁物です。短くて複雑なものより、長くて覚えやすい文のほうが安全です。']
];

/**
 * 新しく足す Tips（v0.74.0）。すでに運用中のシートには入っていないので、RSS の確認のときに1回だけ足す。
 * 同じ見出しのものは入れない。スタッフが消した Tips も、この版では1回だけ戻る（以後は戻らない）。
 */
const TIPS_SYNC_PROPERTY = 'TIPS_SYNC';
const TIPS_SYNC_KEY = 'tips-2026-10';
const WINDOWS_TIPS_NEW = [
  ['Win + Z', 'スナップレイアウトが開き、ウィンドウの並べ方を選べます。大きい画面での作業が楽になります。'],
  ['仮想デスクトップ', '作業ごとに画面を分けられます。Win + Ctrl + D で追加、Win + Ctrl + ←/→ で切り替えます。'],
  ['Win + N', '通知センターとカレンダーを開きます。見逃した通知をここで確かめられます。'],
  ['Win + A', 'クイック設定（Wi-Fi・音量・明るさ・機内モード）を、すぐ開けます。'],
  ['Win + K', 'ワイヤレスで、モニターやスピーカーに画面・音声を送れます。'],
  ['Win + R', '「ファイル名を指定して実行」。appwiz.cpl（アプリの削除）や msinfo32（PCの情報）を直接開けます。'],
  ['Win + X', 'スタートボタンを右クリックしたのと同じメニュー。デバイスマネージャーやディスクの管理にすぐ行けます。'],
  ['Ctrl + Shift + V', '書式を付けずに貼り付けます。Webの文章をメールや Word に貼るときに便利です。'],
  ['Ctrl + Alt + Del', 'PCが固まったときは、ここからタスクマネージャーやサインアウトに進めます。'],
  ['クリップボードの固定', 'Win + V の履歴でピンを付けると、よく使う文章をずっと残せます。'],
  ['ストレージセンス', '設定 → システム → ストレージ で自動の掃除をオンにすると、一時ファイルが自動で減ります。'],
  ['アクティブ時間', '設定 → Windows Update → 詳細オプション で、使う時間帯に再起動されにくくできます。'],
  ['更新の一時停止', '大事な作業の前は、設定 → Windows Update で更新を一時停止できます。ためすぎないこと。'],
  ['応答不可', '設定 → システム → 通知 の「応答不可」で、会議中などに通知を止められます。'],
  ['OneDrive のバックアップ', 'デスクトップ・ドキュメント・ピクチャを OneDrive に自動保存できます。PCが壊れても書類が残ります。'],
  ['Teams の画面共有', '画面共有は、画面全体ではなくウィンドウだけを選ぶと、ほかの情報を見せずに済みます。'],
  ['Outlook の送信取り消し', '新しい Outlook には、送信直後に取り消せる設定があります。設定で秒数を決められます。'],
  ['Excel のオートフィル', 'セルの右下の■をダブルクリックすると、下まで連続でコピー・入力できます。'],
  ['Ctrl + Shift + L（Excel）', 'Excel の表に、フィルターを付けたり外したりできます。'],
  ['BitLocker', 'ノートPCは、デバイスの暗号化（BitLocker）をオンに。落としても中身を読まれにくくなります。'],
  ['Windows セキュリティ', 'スタートで「Windows セキュリティ」を開くと、ウイルス対策やファイアウォールの状態を一目で確かめられます。'],
  ['二段階認証', 'Microsoft アカウントやメールは、二段階認証をオンに。パスワードが漏れても守れます。']
];

/** 新しい Tips を、シートへ1回だけ足す。足した件数を返す */
function syncNewTips_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(TIPS_SYNC_PROPERTY) === TIPS_SYNC_KEY) return 0;
  if (getSettings_()['Tipsを取り込む'] === NO) return 0;
  const r = withLock_(function () { return addTipRows_(WINDOWS_TIPS_NEW); });
  props.setProperty(TIPS_SYNC_PROPERTY, TIPS_SYNC_KEY);
  return r.added;
}
