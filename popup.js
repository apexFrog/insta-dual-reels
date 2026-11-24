const btnToggle = document.getElementById('btn-toggle');
const btnSync = document.getElementById('btn-sync');
const btnQueue = document.getElementById('btn-queue');
const statusMsg = document.getElementById('status-msg');
const audioBtns = Array.from(document.querySelectorAll('.audio-btn'));

let currentTabId = null;
let currentState = {
  active: false,
  syncScroll: true,
  queueMode: 'buffer',
  audioMode: 'left'
};

function render() {
  btnToggle.textContent = currentState.active ? 'Выключить Dual Reels' : 'Включить Dual Reels';
  btnToggle.classList.toggle('active', currentState.active);

  btnSync.textContent = currentState.syncScroll ? 'Вместе' : 'Отдельно';
  btnSync.classList.toggle('on', currentState.syncScroll);

  const isLive = currentState.queueMode === 'live';
  btnQueue.textContent = isLive ? 'Живая ⚡' : 'Буфер (20+)';
  btnQueue.classList.toggle('on', !isLive);

  audioBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.audio === currentState.audioMode);
  });
}

function sendToTab(payload, cb) {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, payload, (resp) => {
    if (chrome.runtime.lastError) {
      statusMsg.style.display = 'block';
      return;
    }
    statusMsg.style.display = 'none';
    if (cb) cb(resp);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs?.[0];
  if (!tab || !tab.id) {
    statusMsg.style.display = 'block';
    return;
  }
  currentTabId = tab.id;

  if (!tab.url || !/instagram\.com\/reels(\/|$|\?)/i.test(tab.url)) {
    statusMsg.textContent = 'Плагин работает только на вкладке Reels (instagram.com/reels/).';
    statusMsg.style.display = 'block';
    btnToggle.textContent = 'Открыть вкладку Reels';
    btnToggle.onclick = () => {
      if (tab.url && tab.url.includes('instagram.com')) {
        chrome.tabs.update(tab.id, { url: 'https://www.instagram.com/reels/' });
      } else {
        chrome.tabs.create({ url: 'https://www.instagram.com/reels/' });
      }
      window.close();
    };
    return;
  }

  sendToTab({ type: 'GET_STATE' }, (resp) => {
    if (resp) {
      currentState = { ...currentState, ...resp };
      render();
    }
  });
});

btnToggle.addEventListener('click', () => {
  sendToTab({ type: 'TOGGLE_DUAL_MODE' }, (resp) => {
    if (resp) {
      currentState.active = resp.active;
      render();
      window.close();
    }
  });
});

btnSync.addEventListener('click', () => {
  currentState.syncScroll = !currentState.syncScroll;
  render();
  sendToTab({ type: 'SET_SYNC', syncScroll: currentState.syncScroll });
});

btnQueue.addEventListener('click', () => {
  currentState.queueMode = currentState.queueMode === 'buffer' ? 'live' : 'buffer';
  render();
  sendToTab({ type: 'SET_QUEUE_MODE', queueMode: currentState.queueMode });
});

audioBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentState.audioMode = btn.dataset.audio;
    render();
    sendToTab({ type: 'SET_AUDIO', audioMode: currentState.audioMode });
  });
});
