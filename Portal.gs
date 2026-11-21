/**
 * Portal.gs … お客様ページ
 *
 * - 入口はURLのトークンだけ。顧客IDでは開けない（IDを知っていても他社は見えない）
 * - 渡す項目はここに書いたものだけ（備考・認証情報・社内メモ・社内向けの項目は渡さない）
 * - 何を見せるかは、顧客ごとの「ポータル表示」で選ぶ（お知らせだけは、公開していれば常に出す）
 * - 公開関数：getPortalData / getPortalLayout / getPortalReport
 */

function pick_(row, names) {
  const out = {};
  names.forEach(function (n) { out[n] = row[n] === undefined ? '' : row[n]; });
  return out;
}

function portalFail_() {
  return appError_('portal', 'このURLは使えません。担当者に確認してください。');
}

/** トークンから顧客を引く。公開していない・停止している・トークンが違うときは例外 */
function portalCustomer_(t) {
  if (typeof t !== 'string' || !/^[0-9a-f]{64}$/.test(t)) throw portalFail_();
  const customer = readTable_(SHEET_CUSTOMERS).rows.filter(function (r) { return r['ポータルトークン'] === t; })[0];
  if (!customer || customer['ポータル公開'] !== YES || customer['状態'] !== '有効') throw portalFail_();
  return customer;
}

function portalTabs_(customer) {
  return String(customer['ポータル表示'] || '').split(',')
    .map(function (x) { return x.trim(); })
    .filter(function (x) { return PORTAL_TABS.indexOf(x) !== -1; });
}

/** 「印刷・PDFにする」ボタンを、この顧客のページに出すか */
function portalCanPrint_(customer) {
  return String(customer['ポータル表示'] || '').split(',').map(function (x) { return x.trim(); }).indexOf(PORTAL_PRINT) !== -1;
}

function portalDeviceLabel_(d) {
  return [d['利用者'], d['機種名']].filter(function (x) { return x; }).join(' / ') || String(d['種類']);
}

/** 今日から過去12か月の 'yyyy-MM'（新しい順） */
function recentMonths_() {
  const p = todayYmd_().split('-');
  const out = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Number(p[0]), Number(p[1]) - 1 - i, 1);
    out.push(d.getFullYear() + '-' + pad2_(d.getMonth() + 1));
  }
  return out;
}

/**
 * お客様ページのデータ。
 * @param {{t:string}} params t はURLのトークン
 */
function getPortalData(params) {
  return api_(function () {
    const customer = portalCustomer_(params && params.t);
    const id = String(customer['顧客ID']);
    const mine = function (r) { return String(r['顧客ID']) === id; };
    const tabs = portalTabs_(customer);
    const settings = getSettings_();
    const today = todayYmd_();
    const out = {
      provider: settings['自社名'] || '',
      customerName: customer['顧客名'],
      today: today,
      licenseWarnDays: settingDays_(settings, 'ライセンス期限の手前日数', 30),
      warrantyWarnDays: settingDays_(settings, '保証期限の手前日数', 60),
      tabs: tabs,
      canPrint: portalCanPrint_(customer),
      // Tips と Windows情報は、公開しているお客様ページすべてのいちばん上に出す（Windows情報は「顧客に見せる」にしたものだけ）
      tips: tipsForClient_(settings),
      wininfo: recentWinInfo_(readTable_(SHEET_WININFO).rows, today, true).map(function (r) { return pick_(r, ['日付', '種類', '重要度', 'タイトル', '内容', 'リンク']); })
    };

    // お知らせ：この顧客あて＋全顧客あてで、掲載期限内のもの
    out.notices = readTable_(SHEET_NOTICES).rows
      .filter(function (n) { return (!n['顧客ID'] || String(n['顧客ID']) === id) && (!n['掲載期限'] || n['掲載期限'] >= today); })
      .sort(function (a, b) { return (a['重要度'] === b['重要度'] ? 0 : a['重要度'] === '重要' ? -1 : 1) || compareDesc_(String(a['登録日時']), String(b['登録日時'])) || compareDesc_(String(a['お知らせID']), String(b['お知らせID'])); })
      .map(function (n) { return { '本文': n['本文'], '重要度': n['重要度'], date: String(n['登録日時']).slice(0, 10) }; });

    const devices = readTable_(SHEET_DEVICES).rows.filter(function (r) { return mine(r) && r['状況'] !== '廃棄'; });
    const deviceLabel = {};
    devices.forEach(function (d) { deviceLabel[String(d['機器ID'])] = portalDeviceLabel_(d); });

    if (tabs.indexOf('機器') !== -1) {
      out.devices = devices.map(function (d) {
        return pick_(d, ['状況', '種類', '設置場所', '部署', '利用者', 'メーカー', '機種名', 'シリアル', '購入日', '保証期限']);
      });
    }
    if (tabs.indexOf('ライセンス') !== -1) {
      const allocations = readTable_(SHEET_ALLOCATIONS).rows;
      out.licenses = readTable_(SHEET_LICENSES).rows.filter(mine).map(function (l) {
        const item = pick_(l, ['製品名', '契約期間', '数量', '有効期限']);
        item['割当先'] = allocations
          .filter(function (a) { return String(a['ライセンスID']) === String(l['ライセンスID']); })
          .map(function (a) { return deviceLabel[String(a['機器ID'])]; })
          .filter(function (x) { return x; });
        return item;
      });
    }
    if (tabs.indexOf('修理') !== -1) {
      out.repairs = readTable_(SHEET_REPAIRS).rows.filter(mine)
        .sort(function (a, b) { return compareDesc_(String(a['受付日']), String(b['受付日'])); })
        .map(function (r) { return pick_(r, ['受付日', '完了日', 'ステータス', '種別', '件名', '預かり品', '型番']); });
    }
    if (tabs.indexOf('対応') !== -1) {
      out.activities = sortActivities_(readTable_(SHEET_ACTIVITIES).rows.filter(mine))
        .slice(0, PORTAL_ACTIVITY_LIMIT)
        .map(function (a) { return pick_(a, ['受付日', '対応種別', 'インシデント種別', 'ステータス', '内容']); });
    }
    if (tabs.indexOf('レイアウト') !== -1) {
      out.layouts = layoutsOf_(id).map(function (r) { return { id: r['レイアウトID'], name: r['名前'] }; });
    }
    if (tabs.indexOf('資料') !== -1) {
      out.files = settings['添付をリンクで共有する'] === NO ? [] : attachRows_()
        .filter(function (r) { return mine(r) && r['お客様に見せる'] === YES; })
        .map(function (r) {
          return { name: r['ファイル名'], size: r['サイズ'], date: String(r['登録日時']).slice(0, 10), url: 'https://drive.google.com/file/d/' + r['DriveファイルID'] + '/view' };
        }).reverse();
    }
    if (tabs.indexOf('レポート') !== -1) out.reportMonths = portalReportMonths_(customer);
    return out;
  });
}

/**
 * お客様ページ用のレイアウト1枚。機器のピンは、名前だけにして渡す（内部のIDは渡さない）。
 * @param {{t:string, layoutId:string}} params
 */
function getPortalLayout(params) {
  return api_(function () {
    const p = params || {};
    const customer = portalCustomer_(p.t);
    if (portalTabs_(customer).indexOf('レイアウト') === -1) throw portalFail_();
    const row = findById_(SHEET_LAYOUTS, 'レイアウトID', p.layoutId);
    if (!row || String(row['顧客ID']) !== String(customer['顧客ID'])) throw portalFail_();
    const label = {};
    readTable_(SHEET_DEVICES).rows.forEach(function (d) {
      if (String(d['顧客ID']) === String(customer['顧客ID']) && d['状況'] !== '廃棄') label[String(d['機器ID'])] = { text: portalDeviceLabel_(d), kind: d['種類'] };
    });
    const full = layoutPayload_(row);
    const elements = [];
    full.elements.forEach(function (el) {
      if (el.type !== 'pin') { elements.push(el); return; }
      const d = label[String(el.deviceId)];
      if (d) elements.push({ type: 'pin', x: el.x, y: el.y, label: d.text, kind: d.kind });
    });
    return { layout: { name: full['名前'], backgroundColor: full.backgroundColor, elements: elements, imageBase64: full.imageBase64, imageMimeType: full.imageMimeType } };
  });
}

/**
 * お客様ページ用の月次レポート。見られるのは過去12か月。
 * @param {{t:string, month:string}} params
 */
function getPortalReport(params) {
  return api_(function () {
    const p = params || {};
    const customer = portalCustomer_(p.t);
    if (portalTabs_(customer).indexOf('レポート') === -1) throw portalFail_();
    const month = checkReportMonth_(p.month);
    if (portalReportMonths_(customer).indexOf(month) === -1) throw appError_('invalid', 'その月のレポートは見られません。');
    const pub = reportPubOf_(customer['顧客ID'])[month];
    return { report: buildReport_(customer, month), note: pub && pub.note ? String(pub.note) : '' };
  });
}
