// サーバー側（.gs）の、Google のサービスを使わない部分のテスト。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadGas } from './gas.mjs';

const G = loadGas();
// 別の場所（vm）で作った配列・オブジェクトを、比べられる形にする
const plain = (v) => JSON.parse(JSON.stringify(v));

test('日付：parseYmd_ は形をそろえ、ない日付は弾く', () => {
  assert.equal(G.parseYmd_('2026-1-5'), '2026-01-05');
  assert.equal(G.parseYmd_('2026/12/31'), '2026-12-31');
  assert.equal(G.parseYmd_('2026-02-29'), null);      // うるう年でない
  assert.equal(G.parseYmd_('2028-02-29'), '2028-02-29');
  assert.equal(G.parseYmd_('2026-13-01'), null);
  assert.equal(G.parseYmd_('1899-01-01'), null);
  assert.equal(G.parseYmd_('きょう'), null);
});

test('日付：parseYmdHm_ は区切りに空白かTを受け、秒は落とす', () => {
  assert.equal(G.parseYmdHm_('2026-10-04 9:05'), '2026-10-04 09:05');
  assert.equal(G.parseYmdHm_('2026-10-04T23:59:30'), '2026-10-04 23:59');
  assert.equal(G.parseYmdHm_('2026-10-04 24:00'), null);
  assert.equal(G.parseYmdHm_('2026-10-04'), null);
});

test('日付：dayDiff_ は月・年・うるう年をまたいでも合う', () => {
  assert.equal(G.dayDiff_('2026-01-31', '2026-02-01'), 1);
  assert.equal(G.dayDiff_('2026-12-31', '2027-01-01'), 1);
  assert.equal(G.dayDiff_('2028-02-28', '2028-03-01'), 2);
  assert.equal(G.dayDiff_('2026-03-10', '2026-03-01'), -9);
  assert.equal(G.dayDiff_('2026-03-10 12:00', '2026-03-11'), 1);   // 時刻は見ない
});

test('シートに書く値：先頭が = + - @ の文字は、数式にならないよう印を付ける', () => {
  assert.equal(G.toCell_('text', '=HYPERLINK("x")'), "'=HYPERLINK(\"x\")");
  assert.equal(G.toCell_('text', '-1'), "'-1");
  assert.equal(G.toCell_('text', '@user'), "'@user");
  assert.equal(G.toCell_('text', '普通の文'), '普通の文');
  assert.equal(G.toCell_('number', '12'), 12);
  assert.equal(G.toCell_('date', 'だめ'), '');
});

test('シートから読む値：fromCell_ は型ごとにそろえる', () => {
  assert.equal(G.fromCell_('date', '2026/1/2'), '2026-01-02');
  assert.equal(G.fromCell_('date', '2026-01-02 10:00'), '2026-01-02');
  assert.equal(G.fromCell_('datetime', '2026-01-02'), '2026-01-02 00:00');
  assert.equal(G.fromCell_('number', ' 7 '), 7);
  assert.equal(G.fromCell_('number', 'abc'), '');
  assert.equal(G.fromCell_('text', ''), '');
  // 日付の値（Date）は、スクリプトのタイムゾーン（東京）で読む
  assert.equal(G.fromCell_('datetime', new Date(Date.UTC(2026, 0, 1, 15, 30))), '2026-01-02 00:30');
});

test('入力の整え：cleanText_ は制御文字を落とし、改行をそろえ、長さで切る', () => {
  assert.equal(G.cleanText_('  あ\u0000い\r\nう\rえ  '), 'あい\nう\nえ');
  assert.equal(G.cleanText_('abcdef', 3), 'abc');
  assert.equal(G.cleanText_(null), '');
  assert.equal(G.cleanText_(12), '12');
});

test('パスワード：作ったハッシュで確かめられ、違うパスワード・壊れた値は通らない', () => {
  const hash = G.makePasswordHash_('correct horse');
  assert.match(hash, /^v1\$\d+\$[0-9a-f]{16}\$[0-9a-f]{64}$/);
  assert.equal(G.verifyPassword_('correct horse', hash), true);
  assert.equal(G.verifyPassword_('correct horsE', hash), false);
  assert.equal(G.verifyPassword_('x', 'v1$999999$salt$00'), false);   // 回数が多すぎる
  assert.equal(G.verifyPassword_('x', ''), false);
  assert.notEqual(G.makePasswordHash_('correct horse'), hash);         // ソルトが毎回違う
});

test('仮パスワード：決めた長さで、読みまちがえやすい文字を使わない', () => {
  for (let i = 0; i < 20; i++) {
    const pw = G.randomPassword_(10);
    assert.equal(pw.length, 10);
    assert.doesNotMatch(pw, /[ilo01IO]/);
  }
});

test('スタッフID：英数字で始まり、メールアドレスの形も使える', () => {
  assert.equal(G.isValidStaffId_('admin'), true);
  assert.equal(G.isValidStaffId_('yu-ya@example.jp'), true);
  assert.equal(G.isValidStaffId_('ab'), false);
  assert.equal(G.isValidStaffId_('.admin'), false);
  assert.equal(G.isValidStaffId_('a b c'), false);
});

test('画面の状態：cleanViewState_ は決めた形だけ残す', () => {
  const v = plain(G.cleanViewState_({
    q: { 'act.text': '印刷', 'bad key': 'x', 'act.long': 'x'.repeat(101) },
    sort: { acts: { i: 2, dir: -1 }, bad: { i: 99, dir: 1 }, x: { i: 1, dir: 0 } },
    per: { act: { mode: 'week' }, rep: { mode: 'year' } },
    extra: 'drop'
  }));
  assert.deepEqual(v, { q: { 'act.text': '印刷' }, sort: { acts: { i: 2, dir: -1 } }, per: { act: { mode: 'week' } } });
  assert.deepEqual(plain(G.cleanViewState_('壊れた値')), { q: {}, sort: {}, per: {} });
});

test('収集ツール：使えないシリアルを見分ける', () => {
  for (const s of ['', 'abc', 'Default string', 'To be filled by O.E.M.', '0000000', '取得失敗', 'System Serial Number']) assert.equal(G.isJunkSerial_(s), true, s);
  assert.equal(G.isJunkSerial_('5CD1234XYZ'), false);
});

test('収集ツール：メーカー名を選択肢に当てはめる（短い名前は語の区切りで）', () => {
  const options = { 'メーカー': ['HP', 'Dell', 'NEC', '富士通', 'Dynabook'].map((value) => ({ value, active: true })) };
  assert.equal(G.normalizeMaker_('Hewlett-Packard', options), 'HP');
  assert.equal(G.normalizeMaker_('HP', options), 'HP');
  assert.equal(G.normalizeMaker_('Dell Inc.', options), 'Dell');
  assert.equal(G.normalizeMaker_('NEC Corporation', options), 'NEC');
  assert.equal(G.normalizeMaker_('TOSHIBA', options), 'Dynabook');
  assert.equal(G.normalizeMaker_('Connecting', options), '');     // 'nec' を含むが、語の区切りではない
  assert.equal(G.normalizeMaker_('Lenovo', options), '');          // 選択肢に無い
});

test('ファイルの中身の先頭が、拡張子と合っているか', () => {
  const bytes = (...b) => b.map((x) => (x > 127 ? x - 256 : x));
  assert.equal(G.looksLike_(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), 'pdf'), true);
  assert.equal(G.looksLike_(bytes(0xff, 0xd8, 0xff), 'jpg'), true);
  assert.equal(G.looksLike_(bytes(0x4d, 0x5a, 0x90), 'jpg'), false);    // exe を jpg と名乗っている
  assert.equal(G.looksLike_(bytes(0x50, 0x4b, 0x03, 0x04), 'xlsx'), true);
  assert.equal(G.looksLike_(bytes(0x89, 0x50, 0x4e, 0x47), 'png'), true);
});

test('画像の data URL：決めた形で、中身も画像のものだけ通す', () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
  assert.equal(G.cleanImageDataUrl_(png, 1000), png);
  assert.equal(G.cleanImageDataUrl_('data:image/svg+xml;base64,PHN2Zz4=', 1000), '');
  assert.equal(G.cleanImageDataUrl_('data:image/png;base64,' + Buffer.from('<html>').toString('base64'), 1000), '');
  assert.equal(G.cleanImageDataUrl_(png, 10), '');      // 長すぎる
});

test('要対応：出さない種類は外し、danger を先に、種類の順に並べる', () => {
  const list = [
    { key: 'repair:R1', category: 'repair', level: 'warn' },
    { key: 'license:L1', category: 'license', level: 'warn' },
    { key: 'disk:D1', category: 'disk', level: 'danger' },
    { key: 'stale:D2', category: 'stale', level: 'warn' },
    { key: 'license:L0', category: 'license', level: 'danger' }
  ];
  const out = plain(G.finishAlerts_(list, { '要対応に出さない種類': 'stale, ないもの' }));
  assert.deepEqual(out.map((a) => a.key), ['disk:D1', 'license:L0', 'license:L1', 'repair:R1']);
});

test('要対応：「対応済み」は、判定値が同じで、再表示日数のあいだだけ', () => {
  const alert = { sig: '2026-10-01|近い' };
  const state = { '判定値': '2026-10-01|近い', '対応済み日時': '2026-10-01 09:00' };
  const settings = { 'アラートの再表示日数': '30' };
  assert.equal(G.isAlertResolved_(alert, state, settings, '2026-10-30'), true);
  assert.equal(G.isAlertResolved_(alert, state, settings, '2026-10-31'), false);     // 30日たった
  assert.equal(G.isAlertResolved_({ sig: '2026-10-01|切れ' }, state, settings, '2026-10-02'), false);   // 状況が変わった
  assert.equal(G.isAlertResolved_(alert, state, { 'アラートの再表示日数': '0' }, '2030-01-01'), true);   // 0は出し直さない
  assert.equal(G.isAlertResolved_(alert, null, settings, '2026-10-02'), false);
});

test('月次レポート：月の指定を確かめ、月末を出す', () => {
  assert.equal(G.monthEnd_('2026-02'), '2026-02-28');
  assert.equal(G.monthEnd_('2028-02'), '2028-02-29');
  assert.equal(G.monthEnd_('2026-12'), '2026-12-31');
  assert.throws(() => G.checkReportMonth_('2026-13'));
  assert.throws(() => G.checkReportMonth_('2999-01'));      // 先の月
  assert.equal(G.checkReportMonth_('2025-04'), '2025-04');
});

test('レイアウト図：知らない種類・ほかの顧客の機器は捨て、値は決めた範囲にする', () => {
  // sanitizeLayoutElements_ は機器のシートを読むので、その部分だけ差し替える
  const g = G.$global, real = g.readTable_;
  g.readTable_ = () => ({ rows: [{ '機器ID': 'D1', '顧客ID': 'C1' }, { '機器ID': 'D9', '顧客ID': 'C2' }] });
  try {
    const out = plain(G.sanitizeLayoutElements_([
      { type: 'pin', x: 10, y: 10, deviceId: 'D1' },
      { type: 'pin', x: 10, y: 10, deviceId: 'D9' },                       // ほかの顧客の機器
      { type: 'desk', x: 500, y: -99, w: 0, h: 8, color: 'red', text: '机', r: 370 },
      { type: 'script', x: 1, y: 1 },                                         // 知らない種類
      { type: 'text', x: 1, y: 1, text: '' },                                 // 空の文字
      { type: 'poly', points: [[0, 0], [10, 'a']] },                          // 形が違う点
      { type: 'icon', x: 1, y: 1, icon: '<b>', size: 20 }                      // 決めたアイコンでない
    ], 'C1'));
    assert.deepEqual(out, [
      { type: 'pin', x: 10, y: 10, deviceId: 'D1' },
      { type: 'desk', x: 120, y: -20, w: 1, h: 8, color: '', text: '机', r: 10 }
    ]);
    assert.throws(() => G.sanitizeLayoutElements_('壊れた値', 'C1'));
  } finally {
    g.readTable_ = real;
  }
});

test('設定の既定値と、画面から変えられる種類が食い違っていない', () => {
  const keys = new Set(plain(G.SETTING_DEFAULTS).map((d) => d[0]));
  for (const k of Object.keys(plain(G.SETTING_TYPES))) assert.ok(keys.has(k), '既定値が無い設定：' + k);
});

test('キャッシュの部品：もとになるシートは、どれも実在するシート名', () => {
  const order = new Set(plain(G.SHEET_ORDER));
  for (const [part, sheets] of Object.entries(plain(G.CACHE_DEPS))) {
    for (const s of sheets) assert.ok(order.has(s), part + ' → ' + s);
  }
  for (const name of order) assert.ok(plain(G.SCHEMA)[name], '列の定義が無いシート：' + name);
});


test('ドライブのURL・IDから、ファイルのIDを取り出す（収集ツールの配布）', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(G.releaseFileId_('https://drive.google.com/file/d/' + id + '/view'), id);
  assert.equal(G.releaseFileId_('https://drive.google.com/open?id=' + id), id);
  assert.equal(G.releaseFileId_(id), id);
  assert.equal(G.releaseFileId_('短い'), '');
});

test('RSS：記事の文字から、タグ・CDATA・文字参照を取りのぞく', () => {
  assert.equal(G.rssText_('<![CDATA[<p>Windows &amp; Office</p>]]>'), 'Windows & Office');
  assert.equal(G.rssText_('&lt;b&gt;太字&lt;/b&gt;'), '太字');
  assert.equal(G.rssText_('&#x30C6;&#12473;&#x30C8;'), 'テスト');
  assert.equal(G.rssText_(null), '');
});

test('RSS：RSS 2.0 と Atom の記事を読み、日付の読めない記事と https 以外のリンクは捨てる', () => {
  const rss = '<rss><channel>' +
    '<item><title>KB5001234 で印刷できない</title><link>https://example.com/a</link><pubDate>Mon, 03 Nov 2026 10:00:00 +0900</pubDate><description>回避策あり</description></item>' +
    '<item><title>日付なし</title><link>https://example.com/b</link></item>' +
    '<item><title>http のリンク</title><link>http://example.com/c</link><pubDate>Tue, 04 Nov 2026 09:00:00 +0900</pubDate></item>' +
    '</channel></rss>';
  const items = plain(G.parseRss_(rss));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'KB5001234 で印刷できない');
  assert.equal(items[0].date, '2026-11-03');
  assert.equal(items[0].link, 'https://example.com/a');
  assert.equal(items[1].link, '');
  const atom = plain(G.parseRss_('<feed><entry><title>Atom の記事</title><link rel="alternate" href="https://example.com/x"/><updated>2026-11-05T01:00:00Z</updated></entry></feed>'));
  assert.equal(atom.length, 1);
  assert.equal(atom[0].link, 'https://example.com/x');
});

test('RSS：記事の種類を決める', () => {
  assert.equal(G.rssKind_('Intel のドライバー更新'), 'ドライバー');
  assert.equal(G.rssKind_('KB5001234 を配信'), '更新プログラム');
  assert.equal(G.rssKind_('新しいノートPCが発売'), 'その他');
});

test('ファイルの版：FILE_MANIFEST のファイルが全部あり、中の版の印と一致する（差し替え漏れ・古いファイルの混入を見つける）', () => {
  const manifest = plain(G.FILE_MANIFEST);
  assert.ok(Object.keys(manifest).length > 0);
  const versions = plain(G.FILE_VERSIONS_);
  for (const [name, want] of Object.entries(manifest)) {
    assert.ok(existsSync(name), name + ' が無い');
    const got = name.endsWith('.gs') ? versions[name] : ((/@file-version (\d+\.\d+\.\d+)/.exec(readFileSync(name, 'utf8')) || [])[1]);
    assert.equal(got, want, name + ' の版が FILE_MANIFEST と違う');
  }
  // FILE_MANIFEST の版の、いちばん新しいものが APP_VERSION
  const newest = Object.values(manifest).sort((a, b) => a.split('.').map(Number).reduce((r, v, i) => r || v - b.split('.').map(Number)[i], 0)).pop();
  assert.equal(G.APP_VERSION, newest);
});

test('管理画面：Admin.html が読み込む部品は、どれも実在し、中に <? が入っていない', () => {
  const admin = readFileSync('Admin.html', 'utf8');
  const used = [...admin.matchAll(/<\?!= include_\('(\w+)'\) \?>/g)].map((m) => m[1]);
  assert.ok(used.includes('AdminCss') && used.includes('AdminCore'));
  for (const name of used) {
    assert.ok(existsSync(name + '.html'), name + '.html が無い');
    assert.ok(!readFileSync(name + '.html', 'utf8').includes('<?'), name + '.html の中に <? があると、そのまま画面に出てしまう');
  }
});
