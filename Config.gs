/**
 * PC管理パッケージ
 * Config.gs … 版、シートの定義、固定の選択肢、入力項目の定義
 *
 * このファイルは「何を持つか」だけを書く。処理は書かない。
 * シートの列を足すときは SCHEMA に追記して「初期設定」を実行する（既存の列は消さない・並べ替えない）。
 */

const APP_VERSION = '0.41.0';
const APP_NAME = 'PC管理';

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
  ['受信トークン', 'text'],  ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_DEVICES] = [
  ['機器ID', 'text'], ['顧客ID', 'text'], ['状況', 'text'], ['種類', 'text'], ['設置場所', 'text'],
  ['部署', 'text'], ['利用者', 'text'], ['ふりがな', 'text'], ['メーカー', 'text'], ['機種名', 'text'],
  ['シリアル', 'text'], ['購入日', 'date'], ['購入元', 'text'], ['保証期限', 'date'], ['備考', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
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
  ['有効期限', 'date'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
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
  ['ピン留め', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_REPAIRS] = [
  ['修理ID', 'text'], ['顧客ID', 'text'], ['機器ID', 'text'], ['元の対応ID', 'text'], ['受付日', 'date'],
  ['完了日', 'date'], ['ステータス', 'text'], ['種別', 'text'], ['預かり品', 'text'], ['型番', 'text'],
  ['シリアル', 'text'], ['先方担当者', 'text'], ['担当スタッフ', 'text'], ['件名', 'text'], ['内容', 'text'],
  ['登録日時', 'datetime'], ['更新日時', 'datetime']
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
// Windows の便利機能（Tips）。配信フォルダーから自動で足される。シートで直接、直す・消す・足すこともできる
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
  ['状態', 'text'], ['用途', 'text'], ['購入日', 'date'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
];
SCHEMA[SHEET_LOANS] = [
  ['貸出ID', 'text'], ['レンタルID', 'text'], ['顧客ID', 'text'], ['貸出先', 'text'], ['貸出日', 'date'], ['返却予定日', 'date'],
  ['返却日', 'date'], ['担当スタッフ', 'text'], ['修理ID', 'text'], ['備考', 'text'], ['登録日時', 'datetime'], ['更新日時', 'datetime']
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
const ACTIVITY_STATUSES = ['完了', '対応中', '保留中'];
const ACTIVITY_HOLD = '保留中';     // 新しく記録するときの、最初のステータス
const ACTIVITY_DONE = '完了';
const REPAIR_STATUSES = ['受付', '実施中', '保留中', '完了'];
const REPAIR_DONE = '完了';
const CREDENTIAL_TARGETS = ['機器', 'ライセンス', 'その他'];
const PORTAL_TABS = ['機器', 'ライセンス', '修理', '対応', 'レイアウト', '資料', 'レポート'];
// タブではないが、顧客ごとに出す・出さないを選ぶもの（「ポータル表示」に、タブと並べて入れる）
const PORTAL_PRINT = '印刷ボタン';
const PORTAL_EXTRAS = [PORTAL_PRINT];
const RENTAL_STATES = ['利用可能', '修理中', '廃棄'];
const RENTAL_AVAILABLE = '利用可能';
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
const FEED_CHECK_SECONDS = 21600;        // 配信フォルダーを確かめる間隔（6時間）
const FEED_MAX_FILES = 12;               // 1回に読む配信ファイルの数
const FEED_MAX_CHARS = 60000;            // 配信ファイル1つの大きさ（文字数）
const FEED_MAX_LINE = 1200;              // 配信ファイルの1行の長さ（これより長い行は読まない）
const FEED_MAX_TIPS_PER_FILE = 20;       // 配信ファイル1つから入れる Tips の数
const FEED_KEEP_DAYS = 60;               // これより前に更新されたファイルは、見ない
const FEED_KEEP_FILES = 60;              // 読み終えた記録を持っておくファイルの数
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
  maintenance: [SHEET_MAINT, '実施ID', '保守']           // v0.15.0 保守の報告書（紙）を撮って付ける
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
const LAYOUT_ICONS = ['🖨️', '📠', '📡', '🗄️', '💾', '☎️', '📺', '🚪', '🪟', '🔌', '🪴', '🚻'];
const AUDIT_VIEW_MAX = 500;
// 古い変更履歴の保管（AuditArchive.gs。v0.40.0）
const AUDIT_ARCHIVE_PROPERTY = 'AUDIT_ARCHIVE_ID';      // 保管用のスプレッドシートのID（スクリプトのプロパティ）
const AUDIT_ARCHIVE_NAME = 'PC管理パッケージ 変更履歴の保管';
const AUDIT_ARCHIVE_MAX_ROWS = 3000;                     // 1回に移す行数の上限（残りは次の朝）
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
const JUNK_SERIAL = /^(取得失敗|不明|未確認|none|n\/a|unknown|default string|system serial number|to be filled.*|0+|1234567890?|demo)$/i;
const RECEIVE_MAX_CHARS = 300000;        // 1回の送信の上限（文字数）
const RECEIVE_MAX_PER_10MIN = 300;       // 1顧客あたり、10分間に受け付ける回数

// 選択肢シートで増やせる区分と、最初に入れておく値
const OPTION_DEFAULTS = {
  '機器種類': ['ノート', 'デスクトップ', 'タブレット', 'サーバー', 'NAS', 'プリンター', 'ネットワーク機器', 'その他'],
  'メーカー': ['HP', 'Dell', 'Lenovo', 'NEC', '富士通', 'Dynabook', 'マウスコンピューター', 'Apple', 'ASUS',
    'Microsoft', 'パナソニック', 'VAIO', 'iiyama', 'その他'],
  '購入元': ['自社', 'その他'],
  '受付方法': ['電話', 'メール', '訪問時', 'その他'],
  '対応種別': ['訪問', 'リモート', '電話', 'あいさつ'],
  'インシデント種別': ['設定依頼', '障害', '相談', 'その他'],
  '修理種別': ['修理', '設定', 'データ復旧'],
  '保守種別': ['定期保守', 'スポット保守', 'その他'],
  '地域': [],
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

// 設定シートの項目  [キー, 既定値, 説明]
const SETTING_DEFAULTS = [
  ['自社名', '', '画面の見出しと、お客様ビューに出す社名'],
  ['開いた直後の画面', 'PC管理', 'ログインした直後に開く画面（PC管理・対応履歴・修理履歴）。スタッフが自分で選んでいないときに使う'],
  ['ウェブアプリURL', '', 'デプロイしたウェブアプリのURL（.../exec）。お客様ビューのURLを作るのに使う'],
  ['ライセンス期限の手前日数', '30', '有効期限がこの日数以内になったライセンスを「期限が近い」として出す'],
  ['保証期限の手前日数', '60', '保証期限がこの日数以内になった機器を「保証が切れる」として出す'],
  ['スタッフに認証情報を見せる', YES, '「いいえ」にすると、パスワード類を表示できるのは管理者だけになる'],
  ['通知先メール', '', '要対応の通知メールを送る先。複数は「,」で区切る（5件まで）。空なら送らない'],
  ['通知の時刻', '8', '毎朝の通知を送る時刻（0〜23時）。変えたらメニューの「毎朝の通知を設定」をやり直す'],
  ['イベントエラーのしきい値', '200', '収集ツールのイベントエラーがこの件数以上の機器を出す。0で出さない'],
  ['ディスク異常を出す', YES, '収集ツールがディスクの異常イベントを見つけた機器を出す'],
  ['収集ツール未受信の日数', '45', '収集ツールからこの日数届いていない機器を出す。0で出さない'],
  ['修理の長期化の日数', '7', '受付からこの日数たっても完了していない修理を出す。0で出さない'],
  ['Cドライブ空きの下限GB', '20', 'ミーティングの「PCの健康チェック」で、Cドライブの空きがこれ（GB）より少ないPCを出す。0で出さない'],
  ['対応の保留の日数', '7', '受付からこの日数たっても完了していない対応を出す。0で出さない'],
  ['リモート多発の回数', '5', '保守契約のある顧客で、今月の「リモート」がこの回数以上になったら出す。0で出さない'],
  ['訪問多発の回数', '10', '保守契約のある顧客で、今月の「訪問」がこの回数以上になったら出す。0で出さない'],
  ['スポット保守の確認日', '20', '毎月この日を過ぎても、今月の対応が無いスポット保守の顧客を出す。0で出さない'],
  ['要対応に出さない種類', '', '要対応に出さない種類（画面の「設定」で選ぶ。ここは直接さわらない）。全員の画面と通知メールから外れる'],
  ['アラートの再表示日数', '30', '「対応済み」にしたアラートを、状況が変わらなくても出し直すまでの日数。0で出し直さない'],
  ['レンタル機器を使う', YES, '「いいえ」にすると、レンタル機器の画面と返却のアラートを出さない'],
  ['レンタル返却の手前日数', '3', '返却予定日がこの日数以内になった貸出を出す（予定日を過ぎたものは常に出す）'],
  ['配信フォルダー', '', 'Windows情報と Tips を自動で取り込む、Google ドライブのフォルダー（URL か ID）。空なら自動では取り込まない'],
  ['Tipsを出す', YES, 'Windowsの便利機能（Tips）を、管理画面とお客様ページのいちばん上に出す'],
  ['Windows情報を取り込む', YES, '配信フォルダーの Windows情報（不具合など）を取り込む。「いいえ」なら取り込まない'],
  ['Tipsを取り込む', YES, '配信フォルダーの Tips を取り込む。「いいえ」なら取り込まない'],
  ['取り込んだWindows情報をお客様に見せる', NO, '「はい」なら、取り込んだ Windows情報をすぐお客様ページにも出す。「いいえ」は社内だけ（確かめてから見せる）'],
  ['変更履歴を残す日数', '365', '日時がこれ（日）より古い変更履歴を、毎朝の処理で「保管用のスプレッドシート」へ移す。0で移さない'],
  ['Windows情報を残す日数', '365', '日付がこれ（日）より古い Windows情報を、毎朝の処理で消す。ピン留めしたものは消さない。0で消さない'],
  ['配信を確かめる間隔（時間）', '6', '配信フォルダーを確かめる間隔（1〜6時間）'],
  ['レポートは公開した月だけ見せる', YES, 'お客様ページの月次レポート。「はい」は、顧客の画面の「レポート」で「お客様ページに出す」を押した月だけ。「いいえ」は、終わった月（過去12か月）を全部見せる'],
  ['添付をリンクで共有する', YES, '「はい」だと、添付はリンクを知っている人が見られる状態で保存する（お客様ページに出すには「はい」が必要）']
];
// 管理画面から変えられる設定のキーと、値の種類
// 開いた直後の画面に選べるもの。前の版の値（ダッシュボード・顧客の一覧）は、どちらも「PC管理」として扱う
const START_VIEWS = ['PC管理', '対応履歴', '修理履歴'];
const SETTING_TYPES = {
  '自社名': 'text',
  '開いた直後の画面': 'start',
  'ウェブアプリURL': 'url',
  'ライセンス期限の手前日数': 'days',
  '保証期限の手前日数': 'days',
  'スタッフに認証情報を見せる': 'yesno',
  '通知先メール': 'emails',
  '通知の時刻': 'hour',
  'イベントエラーのしきい値': 'count',
  'ディスク異常を出す': 'yesno',
  '収集ツール未受信の日数': 'days',
  '修理の長期化の日数': 'days',
  'Cドライブ空きの下限GB': 'count',
  '対応の保留の日数': 'days',
  'リモート多発の回数': 'count',
  '訪問多発の回数': 'count',
  'スポット保守の確認日': 'day',
  '要対応に出さない種類': 'cats',
  'アラートの再表示日数': 'days',
  'レンタル機器を使う': 'yesno',
  'レンタル返却の手前日数': 'days',
  '添付をリンクで共有する': 'yesno',
  'Tipsを出す': 'yesno',
  'Windows情報を取り込む': 'yesno',
  'Tipsを取り込む': 'yesno',
  '取り込んだWindows情報をお客様に見せる': 'yesno',
  '配信を確かめる間隔（時間）': 'count',
  'Windows情報を残す日数': 'count',
  '変更履歴を残す日数': 'count',
  'レポートは公開した月だけ見せる': 'yesno',
  '配信フォルダー': 'folder'
};

// ---------------------------------------------------------------------------
// 要対応アラート  [カテゴリ, 画面に出す名前]。並びは出す順（上ほど先）
// ---------------------------------------------------------------------------
const ALERT_CATEGORIES = [
  ['disk', 'ディスク異常'],
  ['license', 'ライセンス期限'],
  ['rental', 'レンタルの返却'],
  ['repair', '修理の長期化'],
  ['activity', '対応の保留'],
  ['event', 'イベントエラー多発'],
  ['stale', '収集ツール未受信'],
  ['frequent', 'リモート・訪問の多発'],
  ['spotidle', 'スポット保守の対応なし']
];
// 多発の判定で数える対応種別の名前（選択肢シートの値と同じにしておくこと）
const ACTIVITY_KIND_REMOTE = 'リモート';
const ACTIVITY_KIND_VISIT = '訪問';
const ALERT_TRIGGER_FUNCTION = 'runDailyAlerts';
// GAS を起こしておく（v0.21.0）。時間のトリガーで30分ごとに呼び、この時間帯だけ、控え（キャッシュ）を作っておく。
// しばらくだれも使わないと、最初に開く人のときに控えが切れていて遅くなるため
const WARM_TRIGGER_FUNCTION = 'runWarmUp';
const WARM_EVERY_MINUTES = 30;
const WARM_FROM_HOUR = 7;      // この時から
const WARM_TO_HOUR = 19;       // この時の前まで（7〜18時台）
const ALERT_MAIL_MAX_LINES = 60;

// ---------------------------------------------------------------------------
// 入力項目の定義（サーバーの入力チェックと、画面のフォームの両方がこれを使う）
//   type: text / longtext / date / datetime / number / select（固定の選択肢）/ option（選択肢シート）
//         / multi（固定の選択肢から複数）/ yesno / customer / device / staff / secret / rental（レンタル機器）
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
      { name: '状況', type: 'select', choices: DEVICE_STATES, required: true, def: '使用中', chips: true },
      { name: '部署', type: 'text', max: 100 },
      { name: 'ふりがな', type: 'text', max: 60 },
      { name: '購入日', type: 'date' },
      { name: '購入元', type: 'option', category: '購入元' },
      { name: '保証期限', type: 'date' },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  license: {
    label: 'ライセンス', sheet: SHEET_LICENSES, idField: 'ライセンスID', prefix: 'L', digits: 4, nameField: '製品名',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '製品名', type: 'text', required: true, max: 100, quick: true },
      { name: '数量', type: 'number', max: 100000, quick: true },
      { name: '有効期限', type: 'date', quick: true },
      { name: '契約期間', type: 'text', max: 40 },
      { name: '備考', type: 'longtext', max: 2000 }
    ]
  },
  activity: {
    label: '対応履歴', sheet: SHEET_ACTIVITIES, idField: '対応ID', prefix: 'A', digits: 6, nameField: '内容',
    fields: [
      { name: '顧客ID', type: 'customer', required: true, quick: true },
      { name: '機器ID', type: 'device', quick: true },
      { name: '対応種別', type: 'option', category: '対応種別', required: true, quick: true, chips: true },
      { name: 'インシデント種別', type: 'option', category: 'インシデント種別', quick: true, chips: true },
      { name: '内容', type: 'longtext', required: true, max: 5000, quick: true },
      { name: 'ステータス', type: 'select', choices: ACTIVITY_STATUSES, required: true, def: ACTIVITY_HOLD, quick: true, chips: true },
      { name: '受付日', type: 'date', required: true, def: 'today' },
      { name: '受付方法', type: 'option', category: '受付方法', chips: true },
      { name: '先方担当者', type: 'text', max: 60 },
      { name: '受付スタッフ', type: 'staff', def: 'me' },
      { name: '開始日時', type: 'datetime' },
      { name: '完了日時', type: 'datetime' },
      { name: 'ピン留め', type: 'yesno', def: NO }
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
      { name: '内容', type: 'longtext', max: 5000, quick: true },
      { name: 'ステータス', type: 'select', choices: REPAIR_STATUSES, required: true, def: '受付', quick: true, chips: true },
      { name: '受付日', type: 'date', required: true, def: 'today' },
      { name: '完了日', type: 'date' },
      { name: '型番', type: 'text', max: 100 },
      { name: 'シリアル', type: 'text', max: 60 },
      { name: '元の対応ID', type: 'text', max: 20, ref: 'activity' },
      { name: '先方担当者', type: 'text', max: 60 },
      { name: '担当スタッフ', type: 'staff', def: 'me' }
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
      { name: '状態', type: 'select', choices: RENTAL_STATES, required: true, def: RENTAL_AVAILABLE, quick: true, chips: true },
      { name: '用途', type: 'text', max: 60, quick: true },
      { name: 'メーカー', type: 'option', category: 'メーカー' },
      { name: '機種名', type: 'text', max: 100 },
      { name: 'シリアル', type: 'text', max: 60 },
      { name: '購入日', type: 'date' },
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
      { name: '備考', type: 'longtext', max: 2000 }
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
const SERVER_CACHE_SECONDS = 3600;
const CACHE_CHUNK_CHARS = 30000;          // 1つの控えに入れる文字数（CacheService は1つ100KBまで。日本語は1文字3バイト）
const CACHE_MAX_CHUNKS = 12;              // 1つの部品を、いくつまでに分けて控えるか（これより大きい部品は控えない）
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
  photoCounts: [SHEET_ATTACH],
  wininfo: [SHEET_WININFO],
  // 要対応は、もとのシートごとに分けて持つ（設定のしきい値と、顧客の状態・保守契約は、どれにも効く）
  alertsLicense: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_LICENSES],
  alertsRental: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_RENTALS, SHEET_LOANS],
  alertsDevice: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_DEVICES, SHEET_DIAGNOSTICS],
  alertsRepair: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_REPAIRS],
  alertsActivity: [SHEET_SETTINGS, SHEET_CUSTOMERS, SHEET_ACTIVITIES],
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
