(function () {
  var frame = document.getElementById('app');
  var msg = document.getElementById('msg');
  var url = String(window.GAS_URL || '');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    frame.hidden = true;
    msg.hidden = false;
    msg.textContent = 'config.js の GAS_URL に、GAS のウェブアプリのURL（…/exec）を入れてください。';
    return;
  }
  // お客様ページ：?t= に 64文字の合言葉（0-9a-f）が付いている時だけ、GAS にそのまま渡す
  var t = new URLSearchParams(location.search).get('t');
  if (t && /^[0-9a-f]{64}$/.test(t)) {
    url += '?t=' + t;
    document.title = window.PORTAL_TITLE || 'お客様ページ';
  } else if (window.SITE_TITLE) {
    document.title = window.SITE_TITLE;
  }
  frame.src = url;
})();
