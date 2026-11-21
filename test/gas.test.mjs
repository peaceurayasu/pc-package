// サーバー側（.gs）の、Google のサービスを使わない部分のテスト。実行：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('配信ファイル：INFO・TIP・コメント・不正な行を分ける', () => {
  const r = plain(G.parseFeed_([
    '﻿# コメント',
    'INFO｜2026-10-04｜更新プログラム｜重要｜KB0000 で印刷できない｜回避策あり｜https://example.com/a',
    '2026-10-05|ドライバー|通常|タイトルだけ',
    'TIP｜Win + V｜クリップボードの履歴',
    'TIP｜見出しだけ',
    'INFO｜足りない',
    '',
    'x'.repeat(2000)
  ].join('\r\n')));
  assert.equal(r.infos.length, 2);
  assert.deepEqual(r.infos[0], { '日付': '2026-10-04', '種類': '更新プログラム', '重要度': '重要', 'タイトル': 'KB0000 で印刷できない', '内容': '回避策あり', 'リンク': 'https://example.com/a' });
  assert.equal(r.infos[1]['種類'], 'ドライバー');
  assert.deepEqual(r.tips, [['Win + V', 'クリップボードの履歴']]);
  assert.equal(r.bad, 3);
});

test('配信ファイル：知らない種類・重要度は「その他」「通常」にし、長いタイトルは切る', () => {
  const r = plain(G.parseFeed_('2026-10-05|ふしぎ|超重要|' + 'あ'.repeat(80)));
  assert.equal(r.infos[0]['種類'], 'その他');
  assert.equal(r.infos[0]['重要度'], '通常');
  assert.equal(r.infos[0]['タイトル'].length, 60);
});

test('ドライブのURL・IDから、フォルダー・ファイルのIDを取り出す', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(G.feedFolderId_('https://drive.google.com/drive/folders/' + id + '?usp=sharing'), id);
  assert.equal(G.feedFolderId_(id), id);
  assert.equal(G.feedFolderId_('https://example.com/'), '');
  assert.equal(G.releaseFileId_('https://drive.google.com/file/d/' + id + '/view'), id);
  assert.equal(G.releaseFileId_('https://drive.google.com/open?id=' + id), id);
  assert.equal(G.releaseFileId_('短い'), '');
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

test('PCの健康チェック：収集ツールの値から、気になることを拾う', () => {
  const opt = { today: '2026-10-31', freeMin: 20, staleDays: 45 };
  const issues = plain(G.healthIssues_({
    'Cドライブ空き': '8.5', 'ディスク関連イベント': '■ EventID 7', 'バッテリー状態': '劣化状況: 設計容量比 72%',
    'Windows Update': '保留中の更新: 6 件\n最終更新（2026/08/01）', 'クラッシュダンプ': 'クラッシュダンプ 2件検出',
    '前回との比較': '・メモリ 16GB → 8GB\n・スタートアップ +1', '受信日時': '2026-09-01 10:00'
  }, opt));
  const texts = issues.map((i) => i.level + ':' + i.text);
  assert.deepEqual(texts, [
    'danger:Cドライブの空きが 8.5GB', 'danger:ディスクに異常の記録', 'warn:バッテリーの劣化（72%）', 'warn:更新が 6件たまっている',
    'warn:Windows Update が 91日 当たっていない', 'warn:ブルースクリーンの記録', 'warn:前回より：メモリ 16GB → 8GB', 'warn:収集ツールの情報が 60日 届いていない'
  ]);
  assert.deepEqual(plain(G.healthIssues_({ 'Cドライブ空き': '120', 'クラッシュダンプ': 'クラッシュダンプなし', '受信日時': '2026-10-30 08:00' }, opt)), []);
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

test('変更履歴の保管：頭から続けて古い行だけを数える', () => {
  const stamps = ['2025-01-01 09:00', '2025-06-30 23:59', '2025-07-01 00:00', '2024-12-31 10:00'];
  assert.equal(G.auditOldCount_(stamps, '2025-07-01', 100), 2);     // 新しい行で止まる（その後ろの古い行は数えない）
  assert.equal(G.auditOldCount_(stamps, '2025-07-01', 1), 1);       // 上限
  assert.equal(G.auditOldCount_(['', '2020-01-01 00:00'], '2025-07-01', 100), 0);   // 日時の無い行で止まる
  assert.equal(G.auditOldCount_([], '2025-07-01', 100), 0);
});

test('変更履歴の保管：残す日数の設定を読む', () => {
  assert.equal(G.auditKeepDays_({ '変更履歴を残す日数': '365' }), 365);
  assert.equal(G.auditKeepDays_({ '変更履歴を残す日数': '0' }), 0);
  assert.equal(G.auditKeepDays_({ '変更履歴を残す日数': 'だめ' }), 0);
  assert.equal(G.auditKeepDays_({ '変更履歴を残す日数': '999999' }), 36500);
  assert.equal(G.auditKeepDays_({}), 0);
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
