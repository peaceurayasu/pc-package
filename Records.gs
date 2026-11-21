/**
 * Records.gs … 顧客・機器・ライセンス・対応履歴・修理案件・認証情報の登録と編集
 *
 * 入力チェックは Config.gs の ENTITIES の定義に沿って validateEntity_() がまとめて行う。
 * 公開関数はどれも「トークンで本人確認 → ロック → 読み直し → チェック → 書き込み → 変更履歴」の順。
 *
 * 公開関数：saveCustomer / saveDevice / saveLicense / saveActivity / saveRepair / saveCredential
 *           deleteActivity / deleteRepair / deleteLicense / deleteCredential
 *           addAllocation / removeAllocation / listCredentials / revealCredential
 *           addOption / setOptionActive / saveSettings / issuePortalToken / getPortalUrl
 */

// ---------------------------------------------------------------------------
// 入力の整え
// ---------------------------------------------------------------------------
/** 制御文字を落として前後の空白を取る。max を渡すとその長さで切る */
function cleanText_(v, max) {
  let s = String(v === null || v === undefined ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function canSeeSecrets_(me, settings) {
  return me.isAdmin || settings['スタッフに認証情報を見せる'] !== NO;
}

function activeStaffNames_() {
  return refPart_('refStaff').filter(function (s) { return s.enabled; }).map(function (s) { return s.name; });
}

/**
 * 1項目を検証して、シートに入れる形（文字か数値）にそろえる。
 * @param {Object} f       ENTITIES の項目定義
 * @param {*} raw          画面から来た値
 * @param {*} current      編集のときの今の値（新規なら ''）
 * @param {Object} ctx     {options, staffNames}
 */
function normalizeField_(f, raw, current, ctx) {
  const bad = function (msg) { return appError_('invalid', '「' + f.name + '」' + msg); };
  const cur = String(current === null || current === undefined ? '' : current);
  switch (f.type) {
    case 'text':
    case 'secret': {
      const s = cleanText_(raw).replace(/\n/g, ' ');
      if (f.max && s.length > f.max) throw bad('は' + f.max + '文字までです。');
      return s;
    }
    case 'longtext': {
      const s = cleanText_(raw);
      if (f.max && s.length > f.max) throw bad('は' + f.max + '文字までです。');
      return s;
    }
    case 'date': {
      const s = cleanText_(raw);
      if (!s) return '';
      const d = parseYmd_(s);
      if (!d) throw bad('の日付が正しくありません。');
      return d;
    }
    case 'datetime': {
      const s = cleanText_(raw);
      if (!s) return '';
      const d = parseYmdHm_(s);
      if (!d) throw bad('の日時が正しくありません。');
      return d;
    }
    case 'number': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (!/^\d{1,9}$/.test(s)) throw bad('は0以上の整数で入れてください。');
      const n = Number(s);
      if (f.max && n > f.max) throw bad('は' + f.max + '以下にしてください。');
      return n;
    }
    case 'select': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (f.choices.indexOf(s) === -1) throw bad('の値が選択肢にありません。');
      return s;
    }
    case 'yesno': {
      const s = cleanText_(raw);
      if (s !== YES && s !== NO) throw bad('は「はい」か「いいえ」です。');
      return s;
    }
    case 'multi': {
      const list = Array.isArray(raw) ? raw.map(String) : cleanText_(raw).split(',');
      const picked = list.map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      picked.forEach(function (x) {
        if (f.choices.indexOf(x) === -1) throw bad('の値が選択肢にありません。');
      });
      return f.choices.filter(function (c) { return picked.indexOf(c) !== -1; }).join(',');
    }
    case 'option': {
      const s = cleanText_(raw);
      if (!s) return '';
      if (s === cur) return s; // 今は使っていない選択肢でも、編集のたびに弾かない
      const ok = (ctx.options[f.category] || []).some(function (o) { return o.active && o.value === s; });
      if (!ok) throw bad('の値が選択肢にありません。設定の「選択肢」で足してください。');
      return s;
    }
    case 'staff': {
      const s = cleanText_(raw).replace(/\n/g, ' ');
      if (!s || s === cur) return s;
      if (ctx.staffNames.indexOf(s) === -1) throw bad('はスタッフから選んでください。');
      return s;
    }
    case 'customer':
    case 'device':
    case 'rental':
      return cleanText_(raw);
    default:
      throw appError_('server', '項目の定義が正しくありません。');
  }
}

/**
 * 画面から来たデータを検証する。
 * @return {Object} 変える（新規なら入れる）項目だけを持つ {項目名: 値}
 */
function validateEntity_(key, data, existing, me, ctx0) {
  const ent = ENTITIES[key];
  const ctx = ctx0 || { options: getOptions_(), staffNames: activeStaffNames_() };
  const values = {};
  ent.fields.forEach(function (f) {
    if (f.adminOnly && !me.isAdmin) {
      if (!existing) values[f.name] = f.def || '';
      return;
    }
    let raw = data[f.name];
    if (raw === undefined) {
      if (existing) return; // 編集で渡されなかった項目は変えない
      raw = f.def === 'today' ? todayYmd_() : f.def === 'me' ? me.name : (f.def || '');
    }
    const current = existing ? existing[f.name] : '';
    const v = normalizeField_(f, raw, current, ctx);
    if (f.required && v === '') throw appError_('invalid', '「' + f.name + '」を入れてください。');
    values[f.name] = v;
  });

  // 新規・編集のどちらでも、最終的な値で整合を見る
  const merged = {};
  ent.fields.forEach(function (f) {
    merged[f.name] = values[f.name] !== undefined ? values[f.name] : (existing ? existing[f.name] : '');
  });

  // 顧客
  if (merged['顧客ID'] !== undefined && key !== 'customer' && merged['顧客ID'] !== '') {
    if (!cachedFind_('customers', SHEET_CUSTOMERS, '顧客ID', merged['顧客ID'])) throw appError_('invalid', '顧客が見つかりません。');
    if (existing && (key === 'device' || key === 'license' || key === 'credential') &&
        String(existing['顧客ID']) !== String(merged['顧客ID'])) {
      throw appError_('invalid', ent.label + 'の顧客は後から変えられません。新しく登録し直してください。');
    }
  }
  // 機器（その顧客の機器だけ）
  if (merged['機器ID']) {
    const dev = cachedFind_('devices', SHEET_DEVICES, '機器ID', merged['機器ID']);
    if (!dev || String(dev['顧客ID']) !== String(merged['顧客ID'])) {
      throw appError_('invalid', '機器は、選んだ顧客のものから選んでください。');
    }
  }
  if (key === 'repair') {
    if (merged['元の対応ID']) {
      const act = findById_(SHEET_ACTIVITIES, '対応ID', merged['元の対応ID']);
      if (!act || String(act['顧客ID']) !== String(merged['顧客ID'])) {
        throw appError_('invalid', '「元の対応ID」は、同じ顧客の対応履歴のIDを入れてください。');
      }
    }
    if (merged['ステータス'] === REPAIR_DONE && !merged['完了日']) values['完了日'] = merged['完了日'] = todayYmd_();
    if (merged['完了日'] && merged['受付日'] && merged['完了日'] < merged['受付日']) {
      throw appError_('invalid', '完了日が受付日より前になっています。');
    }
  }
  if (key === 'activity') {
    if (merged['開始日時'] && merged['完了日時'] && merged['完了日時'] < merged['開始日時']) {
      throw appError_('invalid', '完了日時が開始日時より前になっています。');
    }
  }
  if (key === 'loan') {
    const rental = findById_(SHEET_RENTALS, 'レンタルID', merged['レンタルID']);
    if (!rental) throw appError_('invalid', 'レンタル機器が見つかりません。');
    if (existing && String(existing['レンタルID']) !== String(merged['レンタルID'])) {
      throw appError_('invalid', '貸出記録のレンタル機器は後から変えられません。新しく登録し直してください。');
    }
    if (!merged['顧客ID'] && !merged['貸出先']) throw appError_('invalid', '「顧客」か「貸出先」のどちらかを入れてください。');
    if (merged['返却予定日'] && merged['返却予定日'] < merged['貸出日']) throw appError_('invalid', '返却予定日が貸出日より前になっています。');
    if (merged['返却日'] && merged['返却日'] < merged['貸出日']) throw appError_('invalid', '返却日が貸出日より前になっています。');
    if (!merged['返却日']) {
      const selfId = existing ? String(existing['貸出ID']) : '';
      const busy = readTable_(SHEET_LOANS).rows.some(function (l) {
        return String(l['レンタルID']) === String(merged['レンタルID']) && !l['返却日'] && String(l['貸出ID']) !== selfId;
      });
      if (busy) throw appError_('invalid', 'この機器は貸出中です。先に返却を記録してください。');
      if (!existing && rental['状態'] !== RENTAL_AVAILABLE) throw appError_('invalid', 'この機器は「' + rental['状態'] + '」なので貸し出せません。');
    }
    if (merged['修理ID'] && !findById_(SHEET_REPAIRS, '修理ID', merged['修理ID'])) throw appError_('invalid', '「修理ID」の修理案件が見つかりません。');
  }
  if (key === 'wininfo') {
    if (merged['リンク'] && !WININFO_LINK.test(merged['リンク'])) throw appError_('invalid', '「リンク」は https:// で始まるURLを入れてください。');
  }
  if (key === 'credential') {
    const kind = merged['対象区分'];
    const target = merged['対象ID'];
    if (kind === 'その他') {
      if (target) values['対象ID'] = '';
    } else if (target) {
      const row = kind === '機器'
        ? findById_(SHEET_DEVICES, '機器ID', target)
        : findById_(SHEET_LICENSES, 'ライセンスID', target);
      if (!row || String(row['顧客ID']) !== String(merged['顧客ID'])) {
        throw appError_('invalid', '「対象ID」は、同じ顧客の' + kind + 'から選んでください。');
      }
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// 画面に渡す形
// ---------------------------------------------------------------------------
function toClient_(key, row) {
  if (key === 'customer') {
    const c = publicRecord_(row, ['ポータルトークン', '受信トークン']);
    c['ポータル発行済'] = !!row['ポータルトークン'];
    c['受信発行済'] = !!row['受信トークン'];
    return c;
  }
  if (key === 'credential') {
    const c = publicRecord_(row, ['パスワード', 'シリアルキー']);
    c['パスワードあり'] = !!row['パスワード'];
    c['シリアルキーあり'] = !!row['シリアルキー'];
    return c;
  }
  return publicRecord_(row);
}

function isSecretField_(key, name) {
  return ENTITIES[key].fields.some(function (f) { return f.name === name && f.type === 'secret'; });
}

function customerIdOf_(key, row) {
  return key === 'customer' ? row[ENTITIES.customer.idField] : (row['顧客ID'] || '');
}

// ---------------------------------------------------------------------------
// 登録・編集の共通処理
// ---------------------------------------------------------------------------
function saveEntity_(key, params, after) {
  const p = params || {};
  const me = requireSession_(p.token);
  const ent = ENTITIES[key];
  const data = p.data && typeof p.data === 'object' ? p.data : {};
  const id = cleanText_(data[ent.idField]);

  // 選択肢とスタッフの名前は、ロックの前に控えから読んでおく（v0.18.0。ロックの中でシートを読まない）
  const ctx0 = { options: getOptions_(), staffNames: activeStaffNames_() };
  return withLock_(function () {
    const existing = id ? findById_(ent.sheet, ent.idField, id) : null;
    if (id && !existing) throw appError_('notfound', 'その' + ent.label + 'が見つかりません。ほかの人が消した可能性があります。');
    // 認証情報を見せない設定のとき、スタッフは「新しく登録」だけできる（見る・直すは管理者だけ。v0.21.0 で v0.19.0 の動きに戻した）
    if (key === 'credential' && existing && !canSeeSecrets_(me, getSettings_())) {
      throw appError_('forbidden', '認証情報の編集は管理者だけができます。');
    }
    const values = validateEntity_(key, data, existing, me, ctx0);
    const now = nowStamp_();

    if (!existing) {
      const newId = nextId_(ent.sheet, ent.idField, ent.prefix, ent.digits);
      const rec = { '登録日時': now, '更新日時': now };
      rec[ent.idField] = newId;
      Object.keys(values).forEach(function (k) { rec[k] = values[k]; });
      appendRecord_(ent.sheet, rec);
      logAudit_(ent.label + '追加', newId, customerIdOf_(key, rec), '', '', auditText_(rec[ent.nameField]), me.name);
      // 書いた値から返事を作る（表を読み直さない）
      const made = { record: toClient_(key, echoRow_(ent.sheet, null, rec)), created: true };
      return after ? Object.assign(made, after(rec, me)) : made;
    }

    const changes = {};
    const names = [], befores = [], afters = [];
    Object.keys(values).forEach(function (k) {
      if (String(values[k]) === String(existing[k] === undefined ? '' : existing[k])) return;
      changes[k] = values[k];
      names.push(k);
      const secret = isSecretField_(key, k);
      befores.push(k + ': ' + (secret ? '（非表示）' : existing[k]));
      afters.push(k + ': ' + (secret ? '（非表示）' : values[k]));
    });
    if (names.length) {
      changes['更新日時'] = now;
      updateRecord_(ent.sheet, existing._row, changes);
      if (changes['顧客ID'] !== undefined) movePhotosOf_(key, id, changes['顧客ID']);
      logAudit_(ent.label + '変更', id, customerIdOf_(key, existing), names.join('、'), befores.join(' / '), afters.join(' / '), me.name);
    }
    const saved = { record: toClient_(key, echoRow_(ent.sheet, existing, changes)), created: false };
    return after ? Object.assign(saved, after(Object.assign({}, existing, changes), me)) : saved;
  });
}

/** 削除の共通処理（管理者） */
function deleteEntity_(key, params) {
  const p = params || {};
  const me = requireSession_(p.token, true);
  const ent = ENTITIES[key];
  return withLock_(function () {
    const row = findById_(ent.sheet, ent.idField, p.id);
    if (!row) throw appError_('notfound', 'その' + ent.label + 'が見つかりません。');
    const id = String(row[ent.idField]);
    const cleared = [];

    if (key === 'license') {
      const used = readTable_(SHEET_CREDENTIALS).rows.some(function (c) {
        return c['対象区分'] === 'ライセンス' && String(c['対象ID']) === id;
      });
      if (used) throw appError_('invalid', 'このライセンスに紐づく認証情報があります。先に認証情報を消すか、対象を変えてください。');
      // 割当は下の行から消す（上から消すと行番号がずれる）
      readTable_(SHEET_ALLOCATIONS).rows
        .filter(function (a) { return String(a['ライセンスID']) === id; })
        .map(function (a) { return a._row; })
        .sort(function (a, b) { return b - a; })
        .forEach(function (rowNumber) { deleteRecord_(SHEET_ALLOCATIONS, rowNumber); });
    }
    if (key === 'rental') {
      const used = readTable_(SHEET_LOANS).rows.some(function (l) { return String(l['レンタルID']) === id; });
      if (used) throw appError_('invalid', '貸出記録があるレンタル機器は削除できません。使わなくなったら、状態を「廃棄」にしてください。');
    }
    if (key === 'repair') {
      readTable_(SHEET_LOANS).rows
        .filter(function (l) { return String(l['修理ID']) === id; })
        .forEach(function (l) { updateRecord_(SHEET_LOANS, l._row, { '修理ID': '', '更新日時': nowStamp_() }); });
    }
    if (key === 'activity') {
      readTable_(SHEET_REPAIRS).rows
        .filter(function (r) { return String(r['元の対応ID']) === id; })
        .forEach(function (r) {
          updateRecord_(SHEET_REPAIRS, r._row, { '元の対応ID': '', '更新日時': nowStamp_() });
          cleared.push(String(r['修理ID']));
        });
    }

    const summary = ent.fields
      .filter(function (f) { return f.type !== 'secret'; })
      .map(function (f) { return f.name + ': ' + row[f.name]; })
      .join(' / ');
    // 付けてあった写真も消す（ドライブのファイルはゴミ箱へ）
    removePhotosOf_(key, id);
    const fresh = findById_(ent.sheet, ent.idField, id);
    deleteRecord_(ent.sheet, fresh._row);
    // 消した Windows情報のピンも外す（同じIDが次の登録で使われても、ピンを引きつがないように。v0.34.0）
    if (key === 'wininfo') {
      const pins = winInfoPins_();
      if (pins.indexOf(id) !== -1) PropertiesService.getScriptProperties().setProperty(WININFO_PIN_PROPERTY, JSON.stringify(pins.filter(function (x) { return x !== id; })));
    }
    logAudit_(ent.label + '削除', id, row['顧客ID'] || '', '', summary, '', me.name);
    return { id: id, clearedRepairIds: cleared };
  });
}

// ---------------------------------------------------------------------------
// 公開関数：登録・編集
//   どれも @param {{token:string, data:Object}} params。data はシートの列名をキーにしたオブジェクト。
//   IDの列（顧客ID・機器ID など）が空なら新規、入っていれば編集。
// ---------------------------------------------------------------------------
function saveCustomer(params) { return api_(function () { return saveEntity_('customer', params); }); }
function saveDevice(params) { return api_(function () { return saveEntity_('device', params); }); }
function saveLicense(params) {
  return api_(function () {
    const p = params || {};
    const cred = licenseCredInput_(p.cred);
    // IDとパスワードを入れられる人か、ライセンスを書く前に確かめる（ライセンスだけ保存されて、返事がエラーにならないように）
    if (cred && !canSeeSecrets_(requireSession_(p.token), getSettings_())) throw appError_('forbidden', 'IDとパスワードの登録は管理者だけができます。');
    return saveEntity_('license', p, cred ? function (lic, me) { return saveLicenseCred_(lic, cred, me); } : null);
  });
}
function saveActivity(params) { return api_(function () { return saveEntity_('activity', params); }); }
function saveRepair(params) { return api_(function () { return saveEntity_('repair', params); }); }
function saveCredential(params) { return api_(function () { return saveEntity_('credential', params); }); }
function saveMaintenance(params) { return api_(function () { return saveEntity_('maintenance', params); }); }
function saveMemo(params) { return api_(function () { return saveEntity_('memo', params); }); }
function saveNotice(params) { return api_(function () { return saveEntity_('notice', params); }); }
function saveWinInfo(params) { return api_(function () { return saveEntity_('wininfo', params); }); }
function saveRental(params) { return api_(function () { return saveEntity_('rental', params); }); }
function saveLoan(params) { return api_(function () { return saveEntity_('loan', params); }); }

// 公開関数：削除（管理者）。@param {{token:string, id:string}} params
function deleteActivity(params) { return api_(function () { return deleteEntity_('activity', params); }); }
function deleteRepair(params) { return api_(function () { return deleteEntity_('repair', params); }); }
function deleteLicense(params) { return api_(function () { return deleteEntity_('license', params); }); }
function deleteCredential(params) { return api_(function () { return deleteEntity_('credential', params); }); }
function deleteMaintenance(params) { return api_(function () { return deleteEntity_('maintenance', params); }); }
function deleteMemo(params) { return api_(function () { return deleteEntity_('memo', params); }); }
function deleteNotice(params) { return api_(function () { return deleteEntity_('notice', params); }); }
function deleteWinInfo(params) { return api_(function () { return deleteEntity_('wininfo', params); }); }
function deleteRental(params) { return api_(function () { return deleteEntity_('rental', params); }); }
function deleteLoan(params) { return api_(function () { return deleteEntity_('loan', params); }); }

// ---------------------------------------------------------------------------
// 変更履歴（管理者）
// ---------------------------------------------------------------------------
/**
 * 変更履歴を新しい順に返す。
 * @param {{token:string, limit:number}} params limit は最大500
 */
function getAuditLog(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    const n = parseInt(p.limit, 10);
    const limit = isFinite(n) && n > 0 ? Math.min(n, AUDIT_VIEW_MAX) : 200;
    // 新しい行（下のほう）だけを読む（v0.40.0。何年ぶんもの履歴を、開くたびに丸ごと読まない）
    const head = tableHead_(SHEET_AUDIT);
    const lastRow = head.sheet.getLastRow();
    const types = typeMap_(SHEET_AUDIT);
    const logs = [];
    if (lastRow >= 2 && head.headers.length) {
      const start = Math.max(2, lastRow - limit + 1);
      head.sheet.getRange(start, 1, lastRow - start + 1, head.headers.length).getValues().forEach(function (r) {
        const obj = {};
        let empty = true;
        head.headers.forEach(function (h, j) {
          if (!h || types[h] === undefined) return;
          const v = fromCell_(types[h], r[j]);
          if (v !== '') empty = false;
          obj[h] = v;
        });
        if (!empty) logs.push(obj);
      });
    }
    return { total: Math.max(0, lastRow - 1), logs: logs.reverse(), archiveUrl: auditArchiveUrl_() };
  });
}

// ---------------------------------------------------------------------------
// ライセンスの割当
// ---------------------------------------------------------------------------
/**
 * ライセンスを機器に割り当てる。
 * @param {{token:string, licenseId:string, deviceId:string}} params
 */
function addAllocation(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const lic = findById_(SHEET_LICENSES, 'ライセンスID', p.licenseId);
      const dev = findById_(SHEET_DEVICES, '機器ID', p.deviceId);
      if (!lic) throw appError_('notfound', 'ライセンスが見つかりません。');
      if (!dev || String(dev['顧客ID']) !== String(lic['顧客ID'])) {
        throw appError_('invalid', '機器は、ライセンスと同じ顧客のものから選んでください。');
      }
      const mine = readTable_(SHEET_ALLOCATIONS).rows.filter(function (a) {
        return String(a['ライセンスID']) === String(lic['ライセンスID']);
      });
      if (mine.some(function (a) { return String(a['機器ID']) === String(dev['機器ID']); })) {
        throw appError_('invalid', 'その機器にはすでに割り当ててあります。');
      }
      if (typeof lic['数量'] === 'number' && lic['数量'] > 0 && mine.length >= lic['数量']) {
        throw appError_('invalid', '数量（' + lic['数量'] + '）を超えるので割り当てられません。');
      }
      const id = nextId_(SHEET_ALLOCATIONS, '割当ID', 'LA', 5);
      appendRecord_(SHEET_ALLOCATIONS, {
        '割当ID': id, 'ライセンスID': lic['ライセンスID'], '機器ID': dev['機器ID'], '割当日': todayYmd_()
      });
      logAudit_('ライセンス割当', lic['ライセンスID'], lic['顧客ID'], '', '', dev['機器ID'], me.name);
      return { allocation: publicRecord_(findById_(SHEET_ALLOCATIONS, '割当ID', id)) };
    });
  });
}

/**
 * 割当を外す。
 * @param {{token:string, allocationId:string}} params
 */
function removeAllocation(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const a = findById_(SHEET_ALLOCATIONS, '割当ID', p.allocationId);
      if (!a) throw appError_('notfound', 'その割当が見つかりません。');
      const lic = findById_(SHEET_LICENSES, 'ライセンスID', a['ライセンスID']);
      deleteRecord_(SHEET_ALLOCATIONS, a._row);
      logAudit_('ライセンス割当解除', a['ライセンスID'], lic ? lic['顧客ID'] : '', '', a['機器ID'], '', me.name);
      return { id: String(a['割当ID']) };
    });
  });
}

// ---------------------------------------------------------------------------
// 認証情報
// ---------------------------------------------------------------------------
/**
 * 顧客の認証情報の一覧（パスワードとシリアルキーは含めない）。
 * @param {{token:string, customerId:string}} params
 */
function listCredentials(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const customerId = cleanText_(p.customerId);
    const rows = readTable_(SHEET_CREDENTIALS).rows.filter(function (r) { return String(r['顧客ID']) === customerId; });
    // 管理者には、パスワードとシリアルキーも最初から渡す（v0.20.0。「表示」を押さなくても見える）。見たことは1行だけ変更履歴に残す
    const withSecrets = me.isAdmin && p.secrets !== false;
    if (withSecrets && p.audit !== false && rows.some(function (r) { return r['パスワード'] || r['シリアルキー']; })) {
      // 変更履歴に書けなくても（ほかの保存と重なった）、一覧は返す
      try { withLock_(function () { logAudit_('認証情報の表示（一覧）', customerId, customerId, '', '', rows.length + '件', me.name); }); }
      catch (e) { console.warn('認証情報の表示を変更履歴に書けませんでした: ' + e); }
    }
    return {
      credentials: rows.map(function (r) {
        const c = toClient_('credential', r);
        if (withSecrets) { c['パスワード'] = String(r['パスワード'] || ''); c['シリアルキー'] = String(r['シリアルキー'] || ''); }
        return c;
      }),
      canReveal: canSeeSecrets_(me, getSettings_()),
      withSecrets: withSecrets
    };
  });
}

/**
 * 認証情報1件のパスワードとシリアルキーを返す。表示したことは変更履歴に残す。
 * @param {{token:string, id:string}} params
 */
function revealCredential(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    if (!canSeeSecrets_(me, getSettings_())) throw appError_('forbidden', '認証情報の表示は管理者だけができます。');
    return withLock_(function () {
      const row = findById_(SHEET_CREDENTIALS, '認証ID', p.id);
      if (!row) throw appError_('notfound', 'その認証情報が見つかりません。');
      logAudit_('認証情報の表示', row['認証ID'], row['顧客ID'], row['名称'], '', '', me.name);
      return { id: String(row['認証ID']), password: row['パスワード'], serialKey: row['シリアルキー'] };
    });
  });
}

// ---------------------------------------------------------------------------
// 選択肢・設定（管理者）
// ---------------------------------------------------------------------------
/**
 * 選択肢を足す。
 * @param {{token:string, category:string, value:string}} params
 */
function addOption(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const category = cleanText_(p.category);
    const value = cleanText_(p.value).replace(/\n/g, ' ');
    if (OPTION_CATEGORIES.indexOf(category) === -1) throw appError_('invalid', '区分が正しくありません。');
    if (!value) throw appError_('invalid', '値を入れてください。');
    if (value.length > 40) throw appError_('invalid', '値は40文字までです。');
    if (value.indexOf(',') !== -1) throw appError_('invalid', '値に「,」は使えません。');
    return withLock_(function () {
      const rows = readTable_(SHEET_OPTIONS).rows.filter(function (r) { return r['区分'] === category; });
      if (rows.some(function (r) { return String(r['値']).trim() === value; })) {
        throw appError_('invalid', 'その値はすでにあります。');
      }
      const order = rows.reduce(function (m, r) { return Math.max(m, Number(r['表示順']) || 0); }, 0) + 10;
      appendRecord_(SHEET_OPTIONS, { '区分': category, '値': value, '表示順': order, '有効': YES });
      logAudit_('選択肢追加', category, '', '', '', value, me.name);
      return { options: getOptions_() };
    });
  });
}

/**
 * 選択肢を使う・使わないを切り替える（消さない。過去のデータに残っている値が読めなくなるのを防ぐ）。
 * @param {{token:string, category:string, value:string, active:boolean}} params
 */
function setOptionActive(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const row = readTable_(SHEET_OPTIONS).rows.filter(function (r) {
        return r['区分'] === String(p.category) && String(r['値']).trim() === String(p.value);
      })[0];
      if (!row) throw appError_('notfound', 'その選択肢が見つかりません。');
      const next = p.active ? YES : NO;
      if (row['有効'] !== next) {
        updateRecord_(SHEET_OPTIONS, row._row, { '有効': next });
        logAudit_('選択肢変更', row['区分'], '', row['値'], '有効:' + row['有効'], '有効:' + next, me.name);
      }
      return { options: getOptions_() };
    });
  });
}

/**
 * 設定を保存する。
 * @param {{token:string, values:Object}} params values は {設定のキー: 値}
 */
function saveSettings(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    const input = p.values && typeof p.values === 'object' ? p.values : {};
    const clean = {};
    Object.keys(SETTING_TYPES).forEach(function (key) {
      if (input[key] === undefined) return;
      const type = SETTING_TYPES[key];
      let v = cleanText_(input[key]).replace(/\n/g, ' ');
      if (type === 'text') {
        if (v.length > 60) throw appError_('invalid', '「' + key + '」は60文字までです。');
      } else if (type === 'url') {
        if (v && !/^https:\/\/script\.google\.com\/[A-Za-z0-9_\-\/.]+\/exec$/.test(v)) {
          throw appError_('invalid', '「' + key + '」は https://script.google.com/…/exec の形で入れてください。');
        }
      } else if (type === 'days' || type === 'count' || type === 'day' || type === 'hour') {
        const max = { days: 3650, count: 99999, day: 31, hour: 23 }[type];
        if (!/^\d{1,5}$/.test(v) || Number(v) > max) throw appError_('invalid', '「' + key + '」は0〜' + max + 'の数字で入れてください。');
        v = String(Number(v));
        if (key === '配信を確かめる間隔（時間）' && (Number(v) < 1 || Number(v) > 6)) throw appError_('invalid', '「' + key + '」は1〜6の数字で入れてください。');
      } else if (type === 'emails') {
        const list = v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
        if (list.length > 5) throw appError_('invalid', '「' + key + '」は5件までです。');
        list.forEach(function (addr) {
          if (addr.length > 120 || !/^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(addr)) {
            throw appError_('invalid', '「' + key + '」のメールアドレスが正しくありません：' + addr.slice(0, 40));
          }
        });
        v = list.join(',');
      } else if (type === 'yesno') {
        if (v !== YES && v !== NO) throw appError_('invalid', '「' + key + '」は「はい」か「いいえ」です。');
      } else if (type === 'folder') {
        if (v) {
          const fid = feedFolderId_(v);
          if (!fid) throw appError_('invalid', '「' + key + '」は、Google ドライブのフォルダーのURLか、IDを入れてください。');
          v = fid;
        }
      } else if (type === 'cats') {
        const known = ALERT_CATEGORIES.map(function (c) { return c[0]; });
        const picked = v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
        picked.forEach(function (k) { if (known.indexOf(k) === -1) throw appError_('invalid', '「' + key + '」に、知らない種類が入っています。'); });
        v = known.filter(function (k) { return picked.indexOf(k) !== -1; }).join(',');
      } else if (type === 'start') {
        if (START_VIEWS.indexOf(v) === -1) throw appError_('invalid', '「' + key + '」は「' + START_VIEWS.join('」か「') + '」です。');
      }
      clean[key] = v;
    });
    return withLock_(function () {
      const rows = readTable_(SHEET_SETTINGS).rows;
      const current = getSettings_();
      Object.keys(clean).forEach(function (key) {
        if (String(current[key]) === clean[key]) return;
        const row = rows.filter(function (r) { return String(r['キー']).trim() === key; })[0];
        if (row) {
          updateRecord_(SHEET_SETTINGS, row._row, { '値': clean[key] });
        } else {
          const def = SETTING_DEFAULTS.filter(function (d) { return d[0] === key; })[0];
          appendRecord_(SHEET_SETTINGS, { 'キー': key, '値': clean[key], '説明': def ? def[2] : '' });
        }
        logAudit_('設定変更', key, '', key, current[key], clean[key], me.name);
      });
      CacheService.getScriptCache().remove(BRAND_CACHE_KEY);
      CacheService.getScriptCache().remove(TIPS_CACHE_KEY);
      CacheService.getScriptCache().remove(FEED_CACHE_KEY);      // 配信フォルダーを変えたら、次に開いたときにすぐ確かめる
      return { settings: publicSettings_(getSettings_()) };
    });
  });
}

function publicSettings_(settings) {
  const out = {};
  Object.keys(SETTING_TYPES).forEach(function (k) { out[k] = settings[k]; });
  return out;
}

// ---------------------------------------------------------------------------
// Windows情報（Windows Update・ドライバーの不具合など）
// ---------------------------------------------------------------------------
function sortWinInfo_(rows) {
  return rows.slice().sort(function (a, b) {
    return compareDesc_(String(a['日付']), String(b['日付'])) || compareDesc_(String(a['情報ID']), String(b['情報ID']));
  });
}

/** ピン留めした Windows情報のID（新しくピン留めしたものが先。v0.33.0） */
function winInfoPins_() {
  let a = null;
  try { a = JSON.parse(PropertiesService.getScriptProperties().getProperty(WININFO_PIN_PROPERTY) || '[]'); } catch (e) { a = null; }
  return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(x); }).slice(0, WININFO_PIN_MAX) : [];
}

/** いちばん上に出すぶん。ピン留めしたものを先に（日付が古くても出す）、残りは日付が新しいものから */
function recentWinInfo_(rows, today, forCustomer) {
  const p = today.split('-');
  const from = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - WININFO_SHOW_DAYS), scriptTz_(), 'yyyy-MM-dd');
  const ok = function (r) { return !forCustomer || r['顧客に見せる'] === YES; };
  const pins = winInfoPins_();
  const pinned = [];
  pins.forEach(function (id) { const r = rows.find(function (x) { return String(x['情報ID']) === id; }); if (r && ok(r)) pinned.push(r); });
  const rest = sortWinInfo_(rows.filter(function (r) {
    return pins.indexOf(String(r['情報ID'])) === -1 && r['日付'] >= from && r['日付'] <= today && ok(r);
  })).slice(0, WININFO_SHOW_MAX);
  return pinned.concat(rest);
}

/**
 * 古い Windows情報を消す（毎朝の処理から。v0.34.0）
 *   設定「Windows情報を残す日数」より日付が古いものを消す。ピン留めしたものは残す。0 なら何もしない。
 * @return {number} 消した件数
 */
function tidyWinInfo_() {
  // 読めない値（文字・マイナス）のときは消さない。大きすぎる値は上限（100年）にする
  const n = parseInt(getSettings_()['Windows情報を残す日数'], 10);
  if (!isFinite(n) || n <= 0) return 0;
  const days = Math.min(n, 36500);
  const today = todayYmd_(), p = today.split('-');
  const before = Utilities.formatDate(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - days), scriptTz_(), 'yyyy-MM-dd');
  return withLock_(function () {
    const pins = winInfoPins_();
    const old = readTable_(SHEET_WININFO).rows.filter(function (r) {
      const d = String(r['日付'] || '');
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < before && pins.indexOf(String(r['情報ID'])) === -1;
    }).sort(function (a, b) { return b._row - a._row; }).slice(0, WININFO_TIDY_MAX);
    old.forEach(function (r) { deleteRecord_(SHEET_WININFO, r._row); });     // 下の行から消す（行番号がずれないように）
    if (old.length) logAudit_('古いWindows情報を片づけ', old.length + '件', '', '', '', before + ' より前', '自動更新');
    return old.length;
  });
}

/**
 * Windows情報をピン留めする・外す（v0.33.0）。ピン留めしたものは、期限（日数）にかかわらず、いちばん上に出しつづける。
 * @param {{token:string, id:string, pin:boolean}} params
 */
function pinWinInfo(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    return withLock_(function () {
      const id = String(p.id || '');
      const row = findById_(SHEET_WININFO, '情報ID', id);
      if (!row) throw appError_('notfound', 'Windows情報が見つかりません。');
      const all = readTable_(SHEET_WININFO).rows.map(function (r) { return String(r['情報ID']); });
      let pins = winInfoPins_().filter(function (x) { return x !== id && all.indexOf(x) !== -1; });   // 消したものは片づける
      if (p.pin === true) {
        if (pins.length >= WININFO_PIN_MAX) throw appError_('invalid', 'ピン留めは' + WININFO_PIN_MAX + '件までです。いらないものを外してください。');
        pins.unshift(id);
      }
      PropertiesService.getScriptProperties().setProperty(WININFO_PIN_PROPERTY, JSON.stringify(pins));
      logAudit_(p.pin === true ? 'Windows情報をピン留め' : 'Windows情報のピンを外す', id, '', '', '', String(row['タイトル'] || ''), me.name);
      return { pins: pins };
    });
  });
}

/**
 * Windows情報を、貼り付けた文からまとめて登録する。1行に1件。
 *   日付｜種類｜重要度｜タイトル｜内容｜リンク　（区切りは「｜」か「|」。内容とリンクは省ける）
 * 同じ日付・同じタイトルのものが既にあれば、その行は飛ばす。
 * @param {{token:string, text:string}} params
 */
function importWinInfo(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token);
    const text = typeof p.text === 'string' ? p.text : '';
    if (text.length > 30000) throw appError_('invalid', '貼り付けた文が長すぎます。');
    const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && l.charAt(0) !== '#'; });
    if (!lines.length) throw appError_('invalid', '登録する行がありません。');
    if (lines.length > WININFO_IMPORT_MAX) throw appError_('invalid', '一度に登録できるのは' + WININFO_IMPORT_MAX + '行までです。');
    return withLock_(function () {
      // 1行ずつ、項目に分ける（形が違う行は null にして、行番号つきで知らせる）
      const items = lines.map(function (line) {
        const c = line.split(/\s*[｜|]\s*/);
        const f = String(c[0]).toUpperCase() === 'INFO' ? c.slice(1) : c;       // 配信ファイルと同じ「INFO｜…」の形でもよい
        if (f.length < 4) return null;
        return { '日付': f[0], '種類': WININFO_KINDS.indexOf(f[1]) !== -1 ? f[1] : 'その他', '重要度': NOTICE_LEVELS.indexOf(f[2]) !== -1 ? f[2] : '通常',
          'タイトル': f[3], '内容': f[4] || '', 'リンク': f[5] || '' };
      });
      const r = addWinInfoRows_(items, YES, me);
      if (r.added) logAudit_('Windows情報をまとめて登録', r.firstId + '〜' + r.lastId, '', '', '', r.added + '件', me.name);
      return { added: r.added, skipped: r.skipped, errors: r.errors, wininfo: sortWinInfo_(readTable_(SHEET_WININFO).rows).map(function (x) { return publicRecord_(x); }) };
    });
  });
}

// ---------------------------------------------------------------------------
// お客様ビューのURL（管理者）
// ---------------------------------------------------------------------------
/** ウェブアプリのURL（.../exec）。設定に入れてあればそれを使う */
function webAppUrl_() {
  return getSettings_()['ウェブアプリURL'] || ScriptApp.getService().getUrl() || '';
}

function portalUrl_(portalToken) {
  if (!portalToken) return '';
  const base = webAppUrl_();
  return base ? base + '?t=' + portalToken : '';
}

/**
 * お客様ビューのURLを発行する。発行し直すと、前のURLは使えなくなる。
 * @param {{token:string, customerId:string}} params
 */
function issuePortalToken(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!c) throw appError_('notfound', '顧客が見つかりません。');
      const portalToken = newToken_();
      const had = !!c['ポータルトークン'];
      updateRecord_(SHEET_CUSTOMERS, c._row, { 'ポータルトークン': portalToken, '更新日時': nowStamp_() });
      logAudit_(had ? 'お客様ビューURL再発行' : 'お客様ビューURL発行', c['顧客ID'], c['顧客ID'], '', '', '', me.name);
      const url = portalUrl_(portalToken);
      return { url: url, needsUrlSetting: !url, record: toClient_('customer', findById_(SHEET_CUSTOMERS, '顧客ID', c['顧客ID'])) };
    });
  });
}

/**
 * 発行済みのお客様ビューのURLを返す。
 * @param {{token:string, customerId:string}} params
 */
function getPortalUrl(params) {
  return api_(function () {
    const p = params || {};
    requireSession_(p.token, true);
    const c = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
    if (!c) throw appError_('notfound', '顧客が見つかりません。');
    const url = portalUrl_(c['ポータルトークン']);
    return { url: url, issued: !!c['ポータルトークン'], needsUrlSetting: !!c['ポータルトークン'] && !url };
  });
}

// ---------------------------------------------------------------------------
// ライセンスの ID・パスワード・シリアルキー（v0.15.0）
//   ライセンスの入力の窓から入れる。入れ先は「認証情報」シート（対象区分＝ライセンス、対象ID＝ライセンスID）。
//   ライセンスのシートの列は変えない。パスワード・シリアルキーは、空のまま送ると「今のまま」。
// ---------------------------------------------------------------------------
/** 画面から来た cred を検査する。送られていなければ null（ライセンスだけ保存する） */
function licenseCredInput_(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw appError_('invalid', 'IDとパスワードの形式が正しくありません。');
  const f = {};
  ENTITIES.credential.fields.forEach(function (x) { f[x.name] = x; });
  const one = function (name, key) {
    const v = raw[key];
    if (v !== undefined && v !== null && typeof v !== 'string') throw appError_('invalid', '「' + name + '」の形式が正しくありません。');
    return normalizeField_(f[name], v || '', '', {});
  };
  return { loginId: one('ログインID', 'loginId'), password: one('パスワード', 'password'), serialKey: one('シリアルキー', 'serialKey'), clear: raw.clear === true };
}

/** ライセンスに紐づく認証情報（いちばん上の1件）。withLock_ の中で呼ぶ */
function licenseCredRow_(licenseId) {
  return readTable_(SHEET_CREDENTIALS).rows.filter(function (c) {
    return c['対象区分'] === 'ライセンス' && String(c['対象ID']) === String(licenseId);
  })[0] || null;
}

/** ライセンスを保存した直後に、IDとパスワードを認証情報に入れる。withLock_ の中で呼ばれる */
function saveLicenseCred_(lic, cred, me) {
  const licenseId = String(lic['ライセンスID']);
  const row = licenseCredRow_(licenseId);
  const now = nowStamp_();
  if (!row) {
    if (!cred.loginId && !cred.password && !cred.serialKey) return { cred: null };
    const id = nextId_(SHEET_CREDENTIALS, '認証ID', ENTITIES.credential.prefix, ENTITIES.credential.digits);
    const rec = {
      '認証ID': id, '顧客ID': String(lic['顧客ID']), '対象区分': 'ライセンス', '対象ID': licenseId,
      '名称': cleanText_(lic['製品名']).slice(0, 100) || 'ライセンス', 'ログインID': cred.loginId, 'パスワード': cred.password,
      'シリアルキー': cred.serialKey, '備考': '', '登録日時': now, '更新日時': now
    };
    appendRecord_(SHEET_CREDENTIALS, rec);
    logAudit_('認証情報追加', id, rec['顧客ID'], '', '', rec['名称'] + '（ライセンスの窓から）', me.name);
    return { cred: toClient_('credential', echoRow_(SHEET_CREDENTIALS, null, rec)) };
  }
  const changes = {};
  const names = [];
  if (cred.loginId !== String(row['ログインID'] || '')) { changes['ログインID'] = cred.loginId; names.push('ログインID'); }
  // パスワード・シリアルキーは、入れたときだけ変える。「消す」を選んだときは空にする
  if (cred.password || cred.clear) { if (cred.password !== String(row['パスワード'] || '')) { changes['パスワード'] = cred.password; names.push('パスワード'); } }
  if (cred.serialKey || cred.clear) { if (cred.serialKey !== String(row['シリアルキー'] || '')) { changes['シリアルキー'] = cred.serialKey; names.push('シリアルキー'); } }
  if (names.length) {
    changes['更新日時'] = now;
    updateRecord_(SHEET_CREDENTIALS, row._row, changes);
    logAudit_('認証情報変更', String(row['認証ID']), String(row['顧客ID']), names.join('、'), '', '（ライセンスの窓から）', me.name);
  }
  return { cred: toClient_('credential', echoRow_(SHEET_CREDENTIALS, row, changes)) };
}

// ---------------------------------------------------------------------------
// 機器を別の顧客へ移す（管理者・v0.15.0）
//   キッティングで「自社キッティング」の顧客に受けた機器を、納品先の顧客へ移すときなどに使う。
//   一緒に移すもの … 機器の写真・その機器の認証情報・その機器を選んである対応履歴／修理／保守（と、その写真）。
//   外すもの     … ライセンスの割当（前の顧客のライセンスなので）。
//   機器診断は機器IDで持っているので、そのまま付いていく。
// ---------------------------------------------------------------------------
/** @param {{token:string, deviceId:string, customerId:string}} params */
function moveDevice(params) {
  return api_(function () {
    const p = params || {};
    const me = requireSession_(p.token, true);
    return withLock_(function () {
      const dev = findById_(SHEET_DEVICES, '機器ID', p.deviceId);
      if (!dev) throw appError_('notfound', 'その機器が見つかりません。');
      const to = findById_(SHEET_CUSTOMERS, '顧客ID', p.customerId);
      if (!to) throw appError_('invalid', '移す先の顧客が見つかりません。');
      const deviceId = String(dev['機器ID']);
      const from = String(dev['顧客ID']);
      const toId = String(to['顧客ID']);
      if (from === toId) throw appError_('invalid', 'いまと同じ顧客です。');
      const now = nowStamp_();
      const moved = { activities: [], repairs: [], maintenances: [], credentials: [], allocations: 0 };

      updateRecord_(SHEET_DEVICES, dev._row, { '顧客ID': toId, '更新日時': now });
      movePhotosOf_('device', deviceId, toId);

      readTable_(SHEET_CREDENTIALS).rows
        .filter(function (c) { return c['対象区分'] === '機器' && String(c['対象ID']) === deviceId; })
        .forEach(function (c) {
          updateRecord_(SHEET_CREDENTIALS, c._row, { '顧客ID': toId, '更新日時': now });
          moved.credentials.push(String(c['認証ID']));
        });

      [['activity', SHEET_ACTIVITIES, '対応ID', 'activities'], ['repair', SHEET_REPAIRS, '修理ID', 'repairs'], ['maintenance', SHEET_MAINT, '実施ID', 'maintenances']]
        .forEach(function (t) {
          readTable_(t[1]).rows
            .filter(function (r) { return String(r['機器ID']) === deviceId && String(r['顧客ID']) !== toId; })
            .forEach(function (r) {
              updateRecord_(t[1], r._row, { '顧客ID': toId, '更新日時': now });
              movePhotosOf_(t[0], String(r[t[2]]), toId);
              moved[t[3]].push(String(r[t[2]]));
            });
        });

      // 修理の「元の対応ID」が、別の顧客の対応を指したままにならないようにする（今回動かしたものに関係する修理だけ）
      const movedActs = {}, movedReps = {};
      moved.activities.forEach(function (x) { movedActs[x] = true; });
      moved.repairs.forEach(function (x) { movedReps[x] = true; });
      const actCust = {};
      readTable_(SHEET_ACTIVITIES).rows.forEach(function (a) { actCust[String(a['対応ID'])] = String(a['顧客ID']); });
      const clearedRepairs = [];
      readTable_(SHEET_REPAIRS).rows.forEach(function (r) {
        const src = String(r['元の対応ID'] || '');
        if (!src || !(movedReps[String(r['修理ID'])] || movedActs[src])) return;
        if (actCust[src] !== undefined && actCust[src] !== String(r['顧客ID'])) {
          updateRecord_(SHEET_REPAIRS, r._row, { '元の対応ID': '', '更新日時': now });
          clearedRepairs.push(String(r['修理ID']));
        }
      });
      // 前の顧客の貸出記録が、移した修理を指したままにならないようにする
      const clearedLoans = [];
      readTable_(SHEET_LOANS).rows.forEach(function (l) {
        if (movedReps[String(l['修理ID'] || '')] && l['顧客ID'] && String(l['顧客ID']) !== toId) {
          updateRecord_(SHEET_LOANS, l._row, { '修理ID': '', '更新日時': now });
          clearedLoans.push(String(l['貸出ID']));
        }
      });

      // ライセンスの割当は外す（下の行から消す）
      const allocRows = readTable_(SHEET_ALLOCATIONS).rows
        .filter(function (a) { return String(a['機器ID']) === deviceId; })
        .map(function (a) { return a._row; })
        .sort(function (a, b) { return b - a; });
      allocRows.forEach(function (rowNumber) { deleteRecord_(SHEET_ALLOCATIONS, rowNumber); });
      moved.allocations = allocRows.length;

      const summary = [custLabel_(from) + ' → ' + custLabel_(toId),
        '対応' + moved.activities.length + '・修理' + moved.repairs.length + '・保守' + moved.maintenances.length + '・認証情報' + moved.credentials.length + '件を一緒に移した',
        moved.allocations ? 'ライセンスの割当' + moved.allocations + '件を外した' : ''].filter(function (x) { return x; }).join(' / ');
      logAudit_('機器の顧客を移動', deviceId, toId, '顧客ID', from, summary, me.name);
      if (from) logAudit_('機器の顧客を移動', deviceId, from, '顧客ID', from, summary, me.name);
      return { record: publicRecord_(findById_(SHEET_DEVICES, '機器ID', deviceId)), moved: moved, clearedRepairIds: clearedRepairs, clearedLoanIds: clearedLoans };
    });
  });
}

function custLabel_(customerId) {
  const c = customerId ? findById_(SHEET_CUSTOMERS, '顧客ID', customerId) : null;
  return c ? String(c['顧客名']) + '（' + customerId + '）' : String(customerId || '（なし）');
}
