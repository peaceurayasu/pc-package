/**
 * Release.gs … 収集ツール（PCInfoTool）の自動更新の配布
 *
 * しくみ
 *   - 管理者が、Google ドライブに置いた新しい PCInfoTool.exe を「設定」→「収集ツールの配布」で登録する
 *     （ドライブのファイルは、このウェブアプリを動かしているアカウントが開けること。共有は「制限付き」のままでよい）
 *   - 登録のときに SHA-256 を計算して ScriptProperties に持つ（シートには書かない）
 *   - ツール（v1.2.0 以降）は GET で問い合わせる
 *       .../exec?action=version&token=受信トークン   … {ok, version, sha256, notes, published}
 *       .../exec?action=download&token=受信トークン  … {ok, version, sha256, data(Base64)}
 *     トークンは、どれかの有効な顧客の「受信トークン」と同じときだけ答える
 *
 * 公開関数：getToolRelease / saveToolRelease（どちらも管理者だけ）
 * doGet からの入口は toolUpdateGet_（Code.gs）
 */

const RELEASE_PROPERTY = 'TOOL_RELEASE';
const RELEASE_MAX_BYTES = 5 * 1024 * 1024;    // 配る exe の上限。ダウンロードのたびに中身を読んで Base64 にするので小さめに（ps2exe の exe はふつう1MB未満）
const RELEASE_VERSION_MAX_PER_10MIN = 1000;   // 1顧客あたり、10分間に答える「版の問い合わせ」の回数
const RELEASE_DOWNLOAD_MAX_PER_10MIN = 30;    // 1顧客あたり、10分間に答えるダウンロードの回数

/** 登録されている配布の情報。無ければ null */
function readRelease_() {
  const raw = PropertiesService.getScriptProperties().getProperty(RELEASE_PROPERTY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || !r.version || !r.fileId || !r.sha256) return null;
    return r;
  } catch (e) { return null; }
}

/** ドライブのファイルの URL か ID から、ファイルIDを取り出す */
function releaseFileId_(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,100})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,100})/.exec(s) || /^([A-Za-z0-9_-]{10,100})$/.exec(s);
  return m ? m[1] : '';
}

/** 符号付きバイト列（-128〜127）の SHA-256 を、大文字の16進で */
function bytesSha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').toUpperCase();
}

/** 画面に見せる形（ファイルIDは管理者だけが見る画面なので出す） */
function releaseForClient_(r) {
  if (!r) return null;
  return { version: r.version, fileId: r.fileId, fileName: r.fileName || '', size: r.size || 0, sha256: r.sha256,
    notes: r.notes || '', published: r.published || '', by: r.by || '' };
}

/**
 * いま配っている版。
 * @param {{token:string}} params
 */
function getToolRelease(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    return { release: releaseForClient_(readRelease_()) };
  });
}

/**
 * 配る版を登録する。file を空にすると、配るのをやめる（ツールは更新しなくなる）。
 * @param {{token:string, file:string, version:string, notes:string}} params
 */
function saveToolRelease(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const props = PropertiesService.getScriptProperties();
    const fileText = typeof p.file === 'string' ? p.file.trim() : '';
    if (!fileText) {
      // 変更履歴はシートに書くので、ロックの中で（v0.19.0）
      return withLock_(function () {
        const before = readRelease_();
        props.deleteProperty(RELEASE_PROPERTY);
        if (before) logAudit_('収集ツールの配布を停止', 'v' + before.version, '', '', before.version, '', me.name);
        return { release: null };
      });
    }

    const fileId = releaseFileId_(fileText);
    if (!fileId) throw appError_('invalid', 'ドライブのファイルのURLかIDを入れてください。');
    const version = typeof p.version === 'string' ? p.version.trim() : '';
    if (!/^\d{1,5}(\.\d{1,5}){1,3}$/.test(version)) throw appError_('invalid', 'バージョンは 1.3.0 のように、数字とピリオドで入れてください。');
    const notes = cleanText_(typeof p.notes === 'string' ? p.notes : '', 300);

    let file;
    try { file = DriveApp.getFileById(fileId); } catch (err) {
      throw appError_('invalid', 'そのファイルを開けません。このアプリを動かしているアカウントのドライブにあるか（共有されているか）確かめてください。');
    }
    if (file.isTrashed && file.isTrashed()) throw appError_('invalid', 'そのファイルはゴミ箱に入っています。');
    const name = String(file.getName() || '');
    if (!/\.exe$/i.test(name)) throw appError_('invalid', '.exe のファイルを選んでください（いまのファイル名：' + name + '）。');
    const size = file.getSize();
    if (!size) throw appError_('invalid', 'ファイルが空です。');
    if (size > RELEASE_MAX_BYTES) throw appError_('invalid', 'ファイルが大きすぎます（5MBまで）。');

    const bytes = file.getBlob().getBytes();
    const release = {
      version: version, fileId: fileId, fileName: name, size: bytes.length, sha256: bytesSha256Hex_(bytes),
      notes: notes, published: nowStamp_(), by: me.name
    };
    return withLock_(function () {
      const before = readRelease_();
      props.setProperty(RELEASE_PROPERTY, JSON.stringify(release));
      logAudit_('収集ツールの配布を登録', 'v' + version, '', 'ファイル', before ? before.version : '', version + '（' + name + '）', me.name);
      return { release: releaseForClient_(release) };
    });
  });
}

/**
 * doGet の ?action=version / ?action=download（収集ツールからの問い合わせ）。
 * 画面のエラー文は出さず、いつも JSON で答える。
 */
function toolUpdateGet_(p) {
  const action = String(p.action || '');
  const deny = function (code) { return jsonOutput_({ ok: false, error: code }); };
  try {
    const token = p.token;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return deny('unauthorized');
    const customer = readTable_(SHEET_CUSTOMERS).rows.filter(function (r) { return r['受信トークン'] === token; })[0];
    if (!customer || customer['状態'] !== '有効') return deny('unauthorized');

    const isDownload = action === 'download';
    const cache = CacheService.getScriptCache();
    const rateKey = (isDownload ? 'updd_' : 'updv_') + customer['顧客ID'];
    const count = Number(cache.get(rateKey)) || 0;
    if (count >= (isDownload ? RELEASE_DOWNLOAD_MAX_PER_10MIN : RELEASE_VERSION_MAX_PER_10MIN)) return deny('busy');
    cache.put(rateKey, String(count + 1), 600);

    const r = readRelease_();
    if (!isDownload) {
      if (!r) return jsonOutput_({ ok: true, version: '' });     // 配っていない
      return jsonOutput_({ ok: true, version: r.version, sha256: r.sha256, notes: r.notes || '', published: r.published || '' });
    }
    if (!r) return deny('norelease');
    let bytes;
    try { bytes = DriveApp.getFileById(r.fileId).getBlob().getBytes(); } catch (err) {
      console.error('配布ファイルを読めません: ' + err);
      return deny('download');
    }
    // 登録のあとにファイルを差し替えられた場合は配らない（ツール側の検証でも止まるが、ここで先に止める）
    if (bytesSha256Hex_(bytes) !== r.sha256) {
      console.error('配布ファイルが登録のあとに変わっています。登録し直してください。');
      return deny('changed');
    }
    return jsonOutput_({ ok: true, version: r.version, sha256: r.sha256, data: Utilities.base64Encode(bytes) });
  } catch (err) {
    console.error('更新の問い合わせで予期しないエラー: ' + (err && err.stack ? err.stack : err));
    return deny('server');
  }
}
