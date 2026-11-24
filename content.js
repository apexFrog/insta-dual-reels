(() => {
  if (window.self !== window.top) return;

  const STORAGE_KEY = 'dualReelsSettings';
  const IG_APP_ID = '936619743392459';
  const BUFFER_TARGET = 20;
  const LIVE_TARGET = 2;

  const seenKeys = new Set();
  const queue = [];

  const state = {
    active: false,
    syncScroll: true,
    queueMode: 'buffer', // 'buffer' (20+ prefetch) | 'live' (on-demand live feed)
    audioMode: 'left', // 'left' | 'right' | 'both' | 'hover' | 'mute'
    volumes: { left: 0.85, right: 0.85 },
    hoveredPane: 'left',
    pausedBoth: false,
    panes: {
      left: { history: [], index: -1 },
      right: { history: [], index: -1 }
    }
  };

  let launcherBtn = null;
  let overlayEl = null;
  let silenceInterval = null;
  let loaderInterval = null;
  let toastTimeout = null;
  let lastWheelTs = 0;
  let lastFeedPumpTs = 0;

  // ===== Settings =====
  function loadSettings() {
    try {
      chrome.storage?.local?.get([STORAGE_KEY], (res) => {
        const saved = res?.[STORAGE_KEY];
        if (saved) {
          if (typeof saved.syncScroll === 'boolean') state.syncScroll = saved.syncScroll;
          if (typeof saved.audioMode === 'string') state.audioMode = saved.audioMode;
          if (saved.queueMode === 'buffer' || saved.queueMode === 'live') {
            state.queueMode = saved.queueMode;
          }
          if (typeof saved.volumes?.left === 'number') state.volumes.left = saved.volumes.left;
          if (typeof saved.volumes?.right === 'number') state.volumes.right = saved.volumes.right;
          updateHudUI();
          applyAudioState();
        }
      });
    } catch {
      // ignore
    }
  }

  function saveSettings() {
    try {
      chrome.storage?.local?.set({
        [STORAGE_KEY]: {
          syncScroll: state.syncScroll,
          audioMode: state.audioMode,
          queueMode: state.queueMode,
          volumes: state.volumes
        }
      });
    } catch {
      // ignore
    }
  }

  function isReelsUrl(url = location.href) {
    return /instagram\.com\/reels(\/|$|\?)/i.test(url);
  }

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function formatCount(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' млн';
    if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + ' тыс.';
    return String(n);
  }

  // ===== Deduplicated Reel Queue =====
  function enqueueReels(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    let added = 0;
    for (const item of items) {
      if (!item || !item.videoUrl) continue;
      const k1 = item.pk ? `pk:${item.pk}` : '';
      const k2 = item.code ? `code:${item.code}` : '';
      const k3 = `url:${item.videoUrl.split('?')[0]}`;
      if ((k1 && seenKeys.has(k1)) || (k2 && seenKeys.has(k2)) || seenKeys.has(k3)) {
        continue;
      }
      if (k1) seenKeys.add(k1);
      if (k2) seenKeys.add(k2);
      seenKeys.add(k3);
      queue.push(item);
      added++;
    }

    if (added > 0 && state.active) {
      updateQueueBadge();
      // Fill any empty pane automatically as soon as reels arrive
      if (state.panes.left.index === -1 && queue.length > 0) {
        stepPane('left', 1);
      }
      if (state.panes.right.index === -1 && queue.length > 0) {
        stepPane('right', 1);
      }
    }
  }

  window.addEventListener('idr-reels-found', (e) => {
    enqueueReels(e.detail);
  });

  // Request already-captured reels from injected.js
  window.dispatchEvent(new Event('idr-request-buffer'));

  // ===== Pump underlying Instagram feed to fetch more personalized Reels =====
  function findUnderlyingScrollContainer() {
    const videos = Array.from(document.querySelectorAll('video')).filter(
      (v) => !overlayEl || !overlayEl.contains(v)
    );
    for (const v of videos) {
      let el = v.parentElement;
      while (el && el !== document.documentElement) {
        const style = getComputedStyle(el);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
          el.scrollHeight > el.clientHeight + 100
        ) {
          return el;
        }
        el = el.parentElement;
      }
    }
    return null;
  }

  function getQueueTarget() {
    return state.queueMode === 'buffer' ? BUFFER_TARGET : LIVE_TARGET;
  }

  function requestMoreReels() {
    if (!state.active) return;
    if (queue.length >= getQueueTarget()) return;
    pumpUnderlyingFeed();
  }

  function pumpUnderlyingFeed() {
    const now = Date.now();
    if (now - lastFeedPumpTs < 900) return;
    lastFeedPumpTs = now;

    window.dispatchEvent(new Event('idr-request-buffer'));

    const container = findUnderlyingScrollContainer();
    if (container) {
      container.scrollTop += Math.max(container.clientHeight * 1.15, 750);
    } else {
      window.scrollBy(0, Math.max(window.innerHeight * 1.15, 750));
    }
  }

  function silenceUnderlyingVideos() {
    document.querySelectorAll('video').forEach((v) => {
      if (overlayEl && overlayEl.contains(v)) return;
      try {
        if (!v.paused) v.pause();
        if (!v.muted) v.muted = true;
      } catch {
        // ignore
      }
    });
  }

  // ===== MAIN-world API Bridge via window.postMessage =====
  let apiReqSeq = 1;
  const pendingApiReqs = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__idr || d.dir !== 'MAIN_TO_ISO') return;
    const resolver = pendingApiReqs.get(d.reqId);
    if (resolver) {
      pendingApiReqs.delete(d.reqId);
      resolver(d.result || { ok: false });
    }
  });

  function callMainApi(action, payload = {}) {
    return new Promise((resolve) => {
      const reqId = `idr_${Date.now()}_${apiReqSeq++}`;
      const timer = setTimeout(() => {
        if (pendingApiReqs.has(reqId)) {
          pendingApiReqs.delete(reqId);
          resolve({ ok: false, timeout: true });
        }
      }, 10000);

      pendingApiReqs.set(reqId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      window.postMessage(
        { __idr: true, dir: 'ISO_TO_MAIN', reqId, action, payload },
        '*'
      );
    });
  }

  // ===== Native Instagram DOM Action Bridge (Zero fake API calls, Zero logout!) =====
  function findUnderlyingReelContainer(reel) {
    if (!reel) return null;
    const vh = window.innerHeight;
    const isOutsideOverlay = (el) => el && (!overlayEl || !overlayEl.contains(el));

    const climbToReelBlock = (startEl) => {
      let el = startEl;
      let best = null;
      while (el && el !== document.body && isOutsideOverlay(el)) {
        const rect = el.getBoundingClientRect();
        const svgs = el.querySelectorAll('svg');
        if (rect.height >= vh * 0.45 && rect.height <= vh * 1.5 && svgs.length >= 3) {
          best = el;
          if (el.querySelector('video')) return el;
        }
        el = el.parentElement;
      }
      return best;
    };

    // 1. Match by reel shortcode link
    if (reel.code) {
      const link = Array.from(
        document.querySelectorAll(`a[href*="/reels/${reel.code}"], a[href*="/p/${reel.code}"]`)
      ).find(isOutsideOverlay);
      if (link) {
        const block = climbToReelBlock(link);
        if (block) return block;
      }
    }

    // 2. Match by author username link inside a reel container
    if (reel.username) {
      const userLinks = Array.from(
        document.querySelectorAll(`a[href="/${reel.username}/"], a[href="/${reel.username}/reels/"]`)
      ).filter(isOutsideOverlay);
      for (const link of userLinks) {
        const block = climbToReelBlock(link);
        if (block) return block;
      }
    }

    return null;
  }

  function clickNativeReelButton(reel, kind) {
    const container = findUnderlyingReelContainer(reel);
    if (!container) return false;

    const matchers = {
      like: /^(like|нравится|me gusta|j'aime|gefällt mir|mi piace|curtir|いいね)$/i,
      unlike: /^(unlike|не нравится|ya no me gusta|je n[’']aime plus|gefällt mir nicht mehr|non mi piace più|descurtir|いいね！を取り消す)$/i,
      save: /^(save|сохранить|guardar|enregistrer|speichern|salva|salvar|保存)$/i,
      unsave: /^(remove|удалить|eliminar|supprimer|entfernen|rimuovi|remover|削除)$/i,
      share: /^(share|поделиться|отправить|send|direct|compartir|partager|teilen|condividi|シェア)$/i
    };

    const re = matchers[kind];
    if (!re) return false;

    const svgs = Array.from(container.querySelectorAll('svg'));
    for (const svg of svgs) {
      const lbl = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '').trim();
      if (re.test(lbl)) {
        const btn = svg.closest('[role="button"], button');
        if (btn) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  }

  function elevateNativeDialogs() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(
      (d) => !overlayEl || !overlayEl.contains(d)
    );
    for (const dlg of dialogs) {
      let root = dlg;
      while (root.parentElement && root.parentElement !== document.body) {
        root = root.parentElement;
      }
      if (root && root !== overlayEl) {
        root.style.setProperty('position', 'relative', 'important');
        root.style.setProperty('z-index', '2147483647', 'important');
      }
    }
  }

  function openReelMiniPopup(reel, autoAction = '') {
    if (!reel?.code) return;
    const url = `https://www.instagram.com/reels/${reel.code}/`;
    const w = 480;
    const h = 780;
    const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
    const winName = autoAction ? `idr_reel_action_${autoAction}` : 'idr_reel_action';
    window.open(url, winName, `width=${w},height=${h},left=${left},top=${top},noopener=no`);
  }

  function sendBg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function executeSilentReelAction(reel, action) {
    if (!reel) return { ok: false };

    // 1. Instant native DOM click if reel is mounted behind our overlay
    if (clickNativeReelButton(reel, action)) {
      return { ok: true };
    }

    // 2. Instant GraphQL/REST replay using webRequest-learned template from background.js
    if (reel.pk) {
      const bgMut = await sendBg({ type: 'GET_LEARNED_MUTATION', action });
      const replayRes = await callMainApi('REPLAY_MUTATION', {
        type: action,
        pk: reel.pk,
        externalTpl: bgMut?.mutation || null
      });
      if (replayRes?.ok) return { ok: true };
    }

    // 3. Silent background tab (active: false, muted) — ZERO popup windows!
    if (reel.code) {
      const bgRes = await sendBg({
        type: 'RUN_SILENT_ACTION',
        code: reel.code,
        action
      });
      if (bgRes?.ok) return { ok: true };
    }

    return { ok: false };
  }

  async function apiToggleLike(reel, shouldLike) {
    return executeSilentReelAction(reel, shouldLike ? 'like' : 'unlike');
  }

  async function apiToggleSave(reel, shouldSave) {
    return executeSilentReelAction(reel, shouldSave ? 'save' : 'unsave');
  }

  // ===== Toast =====
  function showToast(text) {
    if (!overlayEl) return;
    let toast = overlayEl.querySelector('#idr-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'idr-toast';
      overlayEl.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('idr-visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('idr-visible');
    }, 1500);
  }

  // ===== Audio =====
  function computePaneMuted(side) {
    switch (state.audioMode) {
      case 'left':
        return side !== 'left';
      case 'right':
        return side !== 'right';
      case 'both':
        return false;
      case 'mute':
        return true;
      case 'hover':
        return state.hoveredPane !== side;
      default:
        return side !== 'left';
    }
  }

  function applyAudioState() {
    if (!overlayEl) return;
    for (const side of ['left', 'right']) {
      const video = overlayEl.querySelector(`#idr-video-${side}`);
      const audio = overlayEl.querySelector(`#idr-audio-${side}`);
      const muteBtn = overlayEl.querySelector(`#idr-mute-${side}`);
      const volSlider = overlayEl.querySelector(`#idr-vol-${side}`);
      const vol = Math.max(0, Math.min(1, state.volumes[side] ?? 0.85));
      const muted = computePaneMuted(side) || vol === 0;
      const hasSeparateAudio = Boolean(audio && audio.dataset.hasAudio === '1');

      if (hasSeparateAudio) {
        if (video) video.muted = true;
        audio.muted = muted;
        audio.volume = vol;
        if (!muted) {
          if (video && !video.paused && audio.paused) {
            audio.currentTime = video.currentTime || 0;
            audio.play().catch(() => {});
          }
        }
      } else {
        if (audio) audio.muted = true;
        if (video) {
          video.muted = muted;
          video.volume = vol;
        }
      }

      if (volSlider) {
        volSlider.value = String(Math.round((muted ? 0 : vol) * 100));
      }

      if (muteBtn) {
        muteBtn.textContent = muted ? '🔇' : vol < 0.45 ? '🔈' : '🔊';
        muteBtn.classList.toggle('idr-muted', muted);
      }
    }
  }

  function setAudioMode(mode) {
    state.audioMode = mode;
    saveSettings();
    updateHudUI();
    applyAudioState();
    const labels = {
      left: 'Звук: Левый 🔊',
      right: 'Звук: Правый 🔊',
      both: 'Звук: Оба 🔊🔊',
      hover: 'Звук: По наведению 🖱',
      mute: 'Звук: Выключен 🔇'
    };
    showToast(labels[mode] || 'Звук обновлён');
  }

  // ===== Pane Rendering & Navigation =====
  function getCurrentReel(side) {
    const p = state.panes[side];
    if (p.index < 0 || p.index >= p.history.length) return null;
    return p.history[p.index];
  }

  function updateQueueBadge() {
    if (!overlayEl) return;
    const btn = overlayEl.querySelector('#idr-btn-queue');
    const label = overlayEl.querySelector('#idr-queue-label');
    if (btn && label) {
      const isLive = state.queueMode === 'live';
      btn.classList.toggle('idr-live', isLive);
      btn.classList.toggle('idr-active', !isLive);
      label.textContent = isLive ? 'Живая' : `Очередь: ${queue.length}`;
      btn.title = isLive
        ? 'Режим: Живая лента (без предзагрузки). Нажмите или Q для буфера 20+ роликов'
        : `Режим: Буфер (держим ${BUFFER_TARGET}+ роликов). Нажмите или Q для живой ленты`;
    }
  }

  function setQueueMode(mode) {
    state.queueMode = mode === 'live' ? 'live' : 'buffer';
    saveSettings();

    // If switching to Live mode, trim stale prefetched queue down to 2
    if (state.queueMode === 'live' && queue.length > LIVE_TARGET) {
      const trimmed = queue.splice(LIVE_TARGET);
      for (const item of trimmed) {
        if (item.pk) seenKeys.delete(`pk:${item.pk}`);
        if (item.code) seenKeys.delete(`code:${item.code}`);
        if (item.videoUrl) seenKeys.delete(`url:${item.videoUrl.split('?')[0]}`);
      }
    }

    updateQueueBadge();
    if (state.queueMode === 'buffer' && queue.length < BUFFER_TARGET) {
      requestMoreReels();
    }
    showToast(
      state.queueMode === 'live'
        ? '⚡ Живая лента (без буфера)'
        : `📦 Очередь включена (буфер ${BUFFER_TARGET}+ роликов)`
    );
  }

  function toggleQueueMode() {
    setQueueMode(state.queueMode === 'buffer' ? 'live' : 'buffer');
  }

  function renderPane(side) {
    if (!overlayEl) return;
    const reel = getCurrentReel(side);
    const card = overlayEl.querySelector(`.idr-card[data-side="${side}"]`);
    if (!card) return;

    const video = card.querySelector(`#idr-video-${side}`);
    const audio = card.querySelector(`#idr-audio-${side}`);
    const emptyEl = card.querySelector('.idr-empty');
    const avatarEl = card.querySelector('.idr-avatar');
    const userEl = card.querySelector('.idr-username');
    const captionEl = card.querySelector('.idr-caption');
    const likeBtn = card.querySelector('.idr-act-like');
    const likeCountEl = card.querySelector('.idr-like-count');
    const commentCountEl = card.querySelector('.idr-comment-count');
    const saveBtn = card.querySelector('.idr-act-save');
    const openLink = card.querySelector('.idr-act-comments');
    const progressFill = card.querySelector('.idr-progress-fill');

    if (!reel) {
      emptyEl.style.display = 'flex';
      video.removeAttribute('src');
      video.load();
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.dataset.hasAudio = '0';
      }
      return;
    }

    emptyEl.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';

    if (video.dataset.reelId !== reel.id) {
      video.dataset.reelId = reel.id;
      video.poster = reel.posterUrl || '';
      video.src = reel.videoUrl;
      video.loop = true;
      video.playsInline = true;

      const hasDashAudio = Boolean(reel.audioUrl);
      if (audio) {
        audio.pause();
        if (hasDashAudio) {
          audio.dataset.hasAudio = '1';
          audio.src = reel.audioUrl;
          audio.loop = true;
          audio.currentTime = 0;
          audio.muted = computePaneMuted(side);
        } else {
          audio.dataset.hasAudio = '0';
          audio.removeAttribute('src');
        }
      }

      video.muted = hasDashAudio ? true : computePaneMuted(side);
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });

      if (audio && hasDashAudio) {
        audio.play().catch(() => {
          // Will resume once user interacts
        });
      }
    }

    if (reel.avatarUrl) {
      avatarEl.src = reel.avatarUrl;
      avatarEl.style.display = 'block';
    } else {
      avatarEl.style.display = 'none';
    }

    userEl.textContent = reel.username ? `@${reel.username}` : 'Instagram';
    userEl.href = reel.username ? `https://www.instagram.com/${reel.username}/` : '#';

    captionEl.textContent = reel.caption || '';
    captionEl.classList.remove('idr-expanded');

    likeBtn.classList.toggle('idr-liked', Boolean(reel.hasLiked));
    likeCountEl.textContent = formatCount(reel.likeCount);
    commentCountEl.textContent = formatCount(reel.commentCount);
    saveBtn.classList.toggle('idr-saved', Boolean(reel.hasSaved));

    openLink.href = reel.code ? `https://www.instagram.com/reels/${reel.code}/` : 'https://www.instagram.com/reels/';

    applyAudioState();
  }

  function stepPane(side, direction) {
    const p = state.panes[side];
    if (direction > 0) {
      if (p.index < p.history.length - 1) {
        p.index++;
        renderPane(side);
      } else if (queue.length > 0) {
        const nextReel = queue.shift();
        p.history.push(nextReel);
        p.index = p.history.length - 1;
        renderPane(side);
        updateQueueBadge();
      } else {
        showToast('Подгружаем новые рилсы…');
        requestMoreReels();
      }
    } else if (direction < 0) {
      if (p.index > 0) {
        p.index--;
        renderPane(side);
      } else {
        showToast('Это первый рилс в этой колонке');
      }
    }

    if (queue.length < getQueueTarget()) {
      requestMoreReels();
    }
  }

  function stepBoth(direction) {
    stepPane('left', direction);
    stepPane('right', direction);
  }

  function showHeartBurst(side) {
    const stage = overlayEl?.querySelector(`.idr-card[data-side="${side}"] .idr-video-stage`);
    if (!stage) return;
    const burst = document.createElement('div');
    burst.className = 'idr-heart-burst';
    burst.textContent = '❤️';
    stage.appendChild(burst);
    setTimeout(() => burst.remove(), 650);
  }

  async function toggleLikePane(side, likeOnly = false) {
    const reel = getCurrentReel(side);
    if (!reel) return;

    if (likeOnly && reel.hasLiked) {
      showHeartBurst(side);
      return;
    }

    const nextLiked = likeOnly ? true : !reel.hasLiked;
    reel.hasLiked = nextLiked;
    if (typeof reel.likeCount === 'number') {
      reel.likeCount = Math.max(0, reel.likeCount + (nextLiked ? 1 : -1));
    }
    if (nextLiked) showHeartBurst(side);
    renderPane(side);

    const res = await apiToggleLike(reel, nextLiked);
    if (!res?.ok) {
      reel.hasLiked = !nextLiked;
      if (typeof reel.likeCount === 'number') {
        reel.likeCount = Math.max(0, reel.likeCount + (nextLiked ? -1 : 1));
      }
      renderPane(side);
      showToast('Не удалось обновить лайк, попробуйте ещё раз');
    }
  }

  async function toggleSavePane(side) {
    const reel = getCurrentReel(side);
    if (!reel) return;
    const nextSaved = !reel.hasSaved;
    reel.hasSaved = nextSaved;
    renderPane(side);
    const res = await apiToggleSave(reel, nextSaved);
    if (res?.ok) {
      showToast(nextSaved ? '🔖 Сохранено в избранное' : 'Убрано из избранного');
    } else {
      reel.hasSaved = !nextSaved;
      renderPane(side);
      showToast('Не удалось сохранить в избранное, попробуйте ещё раз');
    }
  }

  function likeBoth() {
    toggleLikePane('left', true);
    toggleLikePane('right', true);
    showToast('❤️ Лайк обоим!');
  }

  function togglePlayPauseBoth() {
    if (!overlayEl) return;
    state.pausedBoth = !state.pausedBoth;
    for (const side of ['left', 'right']) {
      const video = overlayEl.querySelector(`#idr-video-${side}`);
      const audio = overlayEl.querySelector(`#idr-audio-${side}`);
      if (!video) continue;
      if (state.pausedBoth) {
        video.pause();
        if (audio) audio.pause();
      } else {
        video.play().catch(() => {});
        if (audio && audio.dataset.hasAudio === '1') {
          audio.currentTime = video.currentTime || 0;
          audio.play().catch(() => {});
        }
      }
    }
    showToast(state.pausedBoth ? '⏸ Пауза обоих' : '▶ Плей обоих');
  }

  function toggleSyncScroll() {
    state.syncScroll = !state.syncScroll;
    saveSettings();
    updateHudUI();
    showToast(state.syncScroll ? 'Прокрутка: Вместе 🔗' : 'Прокрутка: Отдельно ↔');
  }

  // ===== Build Overlay DOM =====
  function buildCardMarkup(side) {
    return `
      <div class="idr-card" data-side="${side}">
        <div class="idr-video-stage">
          <video id="idr-video-${side}" playsinline loop></video>
          <audio id="idr-audio-${side}" loop></audio>

          <div class="idr-empty">
            <div class="idr-spinner"></div>
            <div>Загружаем уникальные рилсы…</div>
          </div>

          <div class="idr-pause-indicator">⏸</div>

          <div class="idr-meta">
            <div class="idr-author-row">
              <img class="idr-avatar" alt="" />
              <a class="idr-username" target="_blank" rel="noopener noreferrer"></a>
            </div>
            <div class="idr-caption" title="Нажмите, чтобы развернуть"></div>
          </div>

          <div class="idr-vol-wrap">
            <div class="idr-vol-pop">
              <input type="range" class="idr-vol-slider" id="idr-vol-${side}" min="0" max="100" value="85" orient="vertical" title="Громкость" />
            </div>
            <button type="button" class="idr-mute-corner" id="idr-mute-${side}" title="Звук этой стороны">🔊</button>
          </div>

          <div class="idr-progress-bar">
            <div class="idr-progress-fill"></div>
          </div>
        </div>

        <div class="idr-actions-col">
          <button type="button" class="idr-act-btn idr-act-like" title="Лайк">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
            <span class="idr-act-count idr-like-count"></span>
          </button>

          <a class="idr-act-btn idr-act-comments" target="_blank" rel="noopener noreferrer" title="Открыть рилс и комментарии">
            <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
            <span class="idr-act-count idr-comment-count"></span>
          </a>

          <button type="button" class="idr-act-btn idr-act-share" title="Поделиться с другом в Direct">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>

          <button type="button" class="idr-act-btn idr-act-save" title="Сохранить">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
          </button>

          <div class="idr-col-nav">
            <button type="button" class="idr-mini-nav idr-mini-up" title="Предыдущий (только эта колонка)">▲</button>
            <button type="button" class="idr-mini-nav idr-mini-down" title="Следующий (только эта колонка)">▼</button>
          </div>
        </div>
      </div>
    `;
  }

  function buildOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'idr-overlay';

    overlayEl.innerHTML = `
      <div id="idr-hud" role="toolbar" aria-label="Dual Reels Controls">
        <button type="button" class="idr-btn" id="idr-btn-sync" title="Режим прокрутки: Вместе / Отдельно (S)">
          <span class="idr-dot"></span>
          <span id="idr-sync-label">Вместе</span>
        </button>

        <div class="idr-sep"></div>

        <div class="idr-audio-group" role="group" aria-label="Звук">
          <button type="button" class="idr-pill" data-audio="left" title="Звук только слева (1)">Л</button>
          <button type="button" class="idr-pill" data-audio="right" title="Звук только справа (2)">П</button>
          <button type="button" class="idr-pill" data-audio="both" title="Звук обоих (3)">Оба</button>
          <button type="button" class="idr-pill" data-audio="hover" title="Звук по наведению (4)">Hover</button>
          <button type="button" class="idr-pill" data-audio="mute" title="Без звука (M)">🔇</button>
        </div>

        <div class="idr-sep"></div>

        <button type="button" class="idr-btn" id="idr-btn-queue" title="Режим очереди: Буфер 20+ / Живая лента (Q)">
          <span class="idr-qdot"></span>
          <span id="idr-queue-label">Очередь: 0</span>
        </button>

        <div class="idr-sep"></div>

        <button type="button" class="idr-btn idr-icon-only" id="idr-btn-playpause" title="Пауза / Плей обоих (Space)">⏯</button>
        <button type="button" class="idr-btn idr-icon-only idr-danger" id="idr-btn-close" title="Закрыть Dual Reels (Esc)">✕</button>
      </div>

      <div id="idr-stage">
        ${buildCardMarkup('left')}
        ${buildCardMarkup('right')}
      </div>

      <div id="idr-side-actions" aria-label="Общие действия для обоих рилсов">
        <button type="button" class="idr-fab idr-fab-heart" id="idr-fab-like-both" title="Лайкнуть оба рилса (L)">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
          </svg>
          <span class="idr-fab-badge">×2</span>
        </button>

        <button type="button" class="idr-fab" id="idr-fab-prev-both" title="Предыдущие оба (↑)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>

        <button type="button" class="idr-fab" id="idr-fab-next-both" title="Следующие оба (↓)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
    `;

    document.documentElement.appendChild(overlayEl);

    // HUD bindings
    overlayEl.querySelector('#idr-btn-sync').addEventListener('click', toggleSyncScroll);
    overlayEl.querySelector('#idr-btn-queue').addEventListener('click', toggleQueueMode);
    overlayEl.querySelectorAll('.idr-pill[data-audio]').forEach((btn) => {
      btn.addEventListener('click', () => setAudioMode(btn.dataset.audio));
    });
    overlayEl.querySelector('#idr-btn-playpause').addEventListener('click', togglePlayPauseBoth);
    overlayEl.querySelector('#idr-btn-close').addEventListener('click', closeDualMode);

    // Far-right combined FABs
    const likeBothBtn = overlayEl.querySelector('#idr-fab-like-both');
    likeBothBtn.addEventListener('click', () => {
      likeBoth();
      likeBothBtn.classList.remove('idr-pop');
      void likeBothBtn.offsetWidth;
      likeBothBtn.classList.add('idr-pop');
    });
    overlayEl.querySelector('#idr-fab-prev-both').addEventListener('click', () => stepBoth(-1));
    overlayEl.querySelector('#idr-fab-next-both').addEventListener('click', () => stepBoth(1));

    // Per-card bindings
    for (const side of ['left', 'right']) {
      const card = overlayEl.querySelector(`.idr-card[data-side="${side}"]`);
      const video = card.querySelector(`#idr-video-${side}`);
      const audio = card.querySelector(`#idr-audio-${side}`);
      const pauseInd = card.querySelector('.idr-pause-indicator');
      const progressFill = card.querySelector('.idr-progress-fill');
      const progressBar = card.querySelector('.idr-progress-bar');

      card.addEventListener('mouseenter', () => {
        if (state.hoveredPane !== side) {
          state.hoveredPane = side;
          if (state.audioMode === 'hover') applyAudioState();
        }
      });

      // Single click = play/pause; double click = like!
      let clickTimer = null;
      video.addEventListener('click', () => {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          toggleLikePane(side, true);
          return;
        }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          if (video.paused) {
            video.play().catch(() => {});
            pauseInd.classList.remove('idr-show');
          } else {
            video.pause();
            pauseInd.classList.add('idr-show');
          }
        }, 210);
      });

      // If separate DASH audio fails to load, fall back to video's own audio track
      if (audio) {
        audio.addEventListener('error', () => {
          audio.dataset.hasAudio = '0';
          applyAudioState();
        });
      }

      // Keep separate DASH audio track tightly synced with video
      video.addEventListener('play', () => {
        pauseInd.classList.remove('idr-show');
        if (audio && audio.dataset.hasAudio === '1') {
          if (Math.abs(audio.currentTime - video.currentTime) > 0.25) {
            audio.currentTime = video.currentTime;
          }
          audio.play().catch(() => {});
        }
      });

      video.addEventListener('pause', () => {
        if (audio && !audio.paused) audio.pause();
      });

      video.addEventListener('seeked', () => {
        if (audio && audio.dataset.hasAudio === '1') {
          audio.currentTime = video.currentTime;
        }
      });

      video.addEventListener('timeupdate', () => {
        if (video.duration > 0) {
          progressFill.style.width = `${(video.currentTime / video.duration) * 100}%`;
        }
        if (audio && audio.dataset.hasAudio === '1' && !video.paused) {
          if (audio.paused) {
            audio.currentTime = video.currentTime;
            audio.play().catch(() => {});
          } else if (Math.abs(audio.currentTime - video.currentTime) > 0.35) {
            audio.currentTime = video.currentTime;
          }
        }
      });

      progressBar.addEventListener('click', (e) => {
        if (!video.duration) return;
        const rect = progressBar.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        video.currentTime = pct * video.duration;
        if (audio && audio.dataset.hasAudio === '1') {
          audio.currentTime = video.currentTime;
        }
      });

      card.querySelector('.idr-caption').addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('idr-expanded');
      });

      card.querySelector(`#idr-mute-${side}`).addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.audioMode === side) setAudioMode('mute');
        else setAudioMode(side);
      });

      const volSlider = card.querySelector(`#idr-vol-${side}`);
      volSlider.addEventListener('click', (e) => e.stopPropagation());
      volSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = Number(e.target.value) / 100;
        state.volumes[side] = val;
        if (val > 0 && computePaneMuted(side)) {
          // Automatically unmute this side if user drags volume up
          if (state.audioMode === 'mute') {
            state.audioMode = side;
          } else if (state.audioMode === 'left' && side === 'right') {
            state.audioMode = 'both';
          } else if (state.audioMode === 'right' && side === 'left') {
            state.audioMode = 'both';
          }
          updateHudUI();
        }
        applyAudioState();
        saveSettings();
      });

      card.querySelector('.idr-act-like').addEventListener('click', () => toggleLikePane(side, false));
      card.querySelector('.idr-act-save').addEventListener('click', () => toggleSavePane(side));
      card.querySelector('.idr-act-share').addEventListener('click', () => {
        const reel = getCurrentReel(side);
        if (reel) openShareModal(reel);
      });

      card.querySelector('.idr-mini-up').addEventListener('click', () => stepPane(side, -1));
      card.querySelector('.idr-mini-down').addEventListener('click', () => stepPane(side, 1));

      // Wheel per card (sync or independent!)
      card.addEventListener(
        'wheel',
        (e) => {
          if (Math.abs(e.deltaY) < 12) return;
          e.preventDefault();
          const now = Date.now();
          if (now - lastWheelTs < 340) return;
          lastWheelTs = now;
          const dir = e.deltaY > 0 ? 1 : -1;
          if (state.syncScroll) {
            stepBoth(dir);
          } else {
            stepPane(side, dir);
          }
        },
        { passive: false }
      );
    }

    updateHudUI();
    updateQueueBadge();
  }

  function updateHudUI() {
    if (!overlayEl) return;
    const syncBtn = overlayEl.querySelector('#idr-btn-sync');
    const syncLabel = overlayEl.querySelector('#idr-sync-label');
    if (syncBtn && syncLabel) {
      syncBtn.classList.toggle('idr-active', state.syncScroll);
      syncLabel.textContent = state.syncScroll ? 'Вместе' : 'Отдельно';
    }
    overlayEl.querySelectorAll('.idr-pill[data-audio]').forEach((btn) => {
      btn.classList.toggle('idr-active', btn.dataset.audio === state.audioMode);
    });
  }

  // ===== Share with a Friend (100% Native Instagram Share Dialog — Zero Logout!) =====
  let shareModalEl = null;

  function closeShareModal() {
    if (shareModalEl) {
      shareModalEl.remove();
      shareModalEl = null;
    }
  }

  function openShareModal(reel) {
    closeShareModal();
    if (!overlayEl || !reel) return;

    // 1. Try opening Instagram's OWN native "Поделиться" dialog right on top of Dual Reels!
    if (clickNativeReelButton(reel, 'share')) {
      setTimeout(elevateNativeDialogs, 80);
      setTimeout(elevateNativeDialogs, 250);
      setTimeout(elevateNativeDialogs, 600);
      return;
    }

    // 2. If this reel was already virtualized out of Instagram's DOM, open a clean native popup that auto-opens Share!
    const url = reel.code ? `https://www.instagram.com/reels/${reel.code}/` : location.href;
    navigator.clipboard?.writeText(url).catch(() => {});
    showToast('✈️ Открываем окно «Поделиться»…');
    openReelMiniPopup(reel, 'share');
  }

  // ===== Open / Close Dual Mode (ONLY on /reels/) =====
  function openDualMode() {
    if (!isReelsUrl()) {
      return;
    }
    if (state.active) return;
    state.active = true;
    state.pausedBoth = false;
    document.documentElement.classList.add('idr-dual-open');

    silenceUnderlyingVideos();
    silenceInterval = setInterval(silenceUnderlyingVideos, 700);

    buildOverlay();
    updateLauncherVisibility();

    // Ask injected.js for any reels already in memory/scripts
    window.dispatchEvent(new Event('idr-request-buffer'));

    // Populate Left and Right with 2 distinct reels
    if (state.panes.left.index === -1 && queue.length > 0) {
      stepPane('left', 1);
    } else {
      renderPane('left');
    }

    if (state.panes.right.index === -1 && queue.length > 0) {
      stepPane('right', 1);
    } else {
      renderPane('right');
    }

    // Keep queue topped up automatically (fast 750ms cadence for 20+ buffer)
    if (queue.length < getQueueTarget()) requestMoreReels();
    loaderInterval = setInterval(() => {
      if (state.active && queue.length < getQueueTarget()) {
        requestMoreReels();
      }
    }, 750);
  }

  function closeDualMode() {
    if (!state.active) return;
    state.active = false;
    document.documentElement.classList.remove('idr-dual-open');
    if (silenceInterval) {
      clearInterval(silenceInterval);
      silenceInterval = null;
    }
    if (loaderInterval) {
      clearInterval(loaderInterval);
      loaderInterval = null;
    }
    if (overlayEl) {
      closeShareModal();
      overlayEl.querySelectorAll('video, audio').forEach((m) => {
        try {
          m.pause();
          m.removeAttribute('src');
        } catch {
          // ignore
        }
      });
      overlayEl.remove();
      overlayEl = null;
    }
    updateLauncherVisibility();
  }

  // ===== Launcher button on normal Instagram Reels =====
  function createLauncherButton() {
    if (launcherBtn) return;
    launcherBtn = document.createElement('button');
    launcherBtn.id = 'idr-launcher-btn';
    launcherBtn.type = 'button';
    launcherBtn.title = 'Открыть Dual Reels (2 уникальных рилса в одной вкладке)';
    launcherBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="8" height="18" rx="2"></rect>
        <rect x="14" y="3" width="8" height="18" rx="2"></rect>
      </svg>
      <span>Dual Reels</span>
    `;
    launcherBtn.addEventListener('click', openDualMode);
    document.documentElement.appendChild(launcherBtn);
  }

  function updateLauncherVisibility() {
    if (window.name && window.name.startsWith('idr_reel_action')) {
      if (launcherBtn) launcherBtn.style.display = 'none';
      return;
    }
    if (!launcherBtn) createLauncherButton();
    launcherBtn.style.display = !state.active && isReelsUrl() ? 'inline-flex' : 'none';
  }

  // Auto-open Instagram's native "Поделиться" sheet or auto-close calibration popup
  function initMiniActionPopupIfNeeded() {
    if (!window.name || !window.name.startsWith('idr_reel_action')) return false;

    const action = window.name.replace('idr_reel_action_', '');

    if (action === 'like' || action === 'save') {
      // Mute video in calibration popup and auto-close once the mutation is learned
      setInterval(() => {
        document.querySelectorAll('video').forEach((v) => {
          try {
            v.muted = true;
          } catch {
            // ignore
          }
        });
      }, 400);

      window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (d && d.__idr && d.dir === 'MAIN_TO_ISO' && d.learned) {
          setTimeout(() => window.close(), 450);
        }
      });
      return true;
    }

    if (action === 'share') {
      const shareRe = /^(share|поделиться|отправить|send|direct|compartir|partager|teilen|condividi|シェア)$/i;
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        // Mute/pause video inside the share popup so it doesn't overlap Dual Reels audio
        document.querySelectorAll('video').forEach((v) => {
          try {
            v.muted = true;
            if (!v.paused) v.pause();
          } catch {
            // ignore
          }
        });

        // If Share dialog is already open, we're done!
        if (document.querySelector('[role="dialog"]')) {
          clearInterval(timer);
          return;
        }

        const svgs = Array.from(document.querySelectorAll('svg'));
        for (const svg of svgs) {
          const lbl = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '').trim();
          if (shareRe.test(lbl)) {
            const btn = svg.closest('[role="button"], button');
            if (btn) {
              btn.click();
              clearInterval(timer);
              return;
            }
          }
        }

        if (attempts >= 30) {
          clearInterval(timer);
        }
      }, 250);
    }
    return true;
  }

  // ===== Keyboard Shortcuts =====
  window.addEventListener('keydown', (e) => {
    if (!state.active) return;
    const tag = e.target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;

    switch (e.code) {
      case 'KeyS':
        e.preventDefault();
        toggleSyncScroll();
        break;
      case 'KeyQ':
        e.preventDefault();
        toggleQueueMode();
        break;
      case 'KeyL':
        e.preventDefault();
        likeBoth();
        break;
      case 'Space':
        e.preventDefault();
        togglePlayPauseBoth();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (state.syncScroll) stepBoth(1);
        else stepPane(state.hoveredPane, 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (state.syncScroll) stepBoth(-1);
        else stepPane(state.hoveredPane, -1);
        break;
      case 'Digit1':
        e.preventDefault();
        setAudioMode('left');
        break;
      case 'Digit2':
        e.preventDefault();
        setAudioMode('right');
        break;
      case 'Digit3':
        e.preventDefault();
        setAudioMode('both');
        break;
      case 'Digit4':
        e.preventDefault();
        setAudioMode('hover');
        break;
      case 'KeyM':
        e.preventDefault();
        setAudioMode(state.audioMode === 'mute' ? 'left' : 'mute');
        break;
      case 'Escape':
        e.preventDefault();
        if (shareModalEl) closeShareModal();
        else closeDualMode();
        break;
    }
  });

  // ===== Popup Messages =====
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'GET_STATE') {
        sendResponse({
          active: state.active,
          syncScroll: state.syncScroll,
          queueMode: state.queueMode,
          audioMode: state.audioMode,
          queueCount: queue.length
        });
        return true;
      }
      if (msg.type === 'TOGGLE_DUAL_MODE') {
        if (state.active) closeDualMode();
        else openDualMode();
        sendResponse({ active: state.active });
        return true;
      }
      if (msg.type === 'SET_SYNC') {
        state.syncScroll = Boolean(msg.syncScroll);
        saveSettings();
        updateHudUI();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'SET_QUEUE_MODE') {
        setQueueMode(msg.queueMode);
        sendResponse({ ok: true, queueMode: state.queueMode });
        return true;
      }
      if (msg.type === 'SET_AUDIO') {
        setAudioMode(msg.audioMode);
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch {
    // ignore
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (!isReelsUrl() && state.active) {
        closeDualMode();
      }
      updateLauncherVisibility();
    }
  }, 500);

  // Silent background tab runner (zero visible popup windows!)
  async function runBackgroundTaskIfAssigned() {
    const resp = await sendBg({ type: 'GET_BG_TASK' });
    const action = resp?.action;
    if (!action) return false;

    const matchers = {
      like: /^(like|нравится|me gusta|j'aime|gefällt mir|mi piace|curtir|いいね)$/i,
      unlike: /^(unlike|не нравится|ya no me gusta|je n[’']aime plus|gefällt mir nicht mehr|non mi piace più|descurtir|いいね！を取り消す)$/i,
      save: /^(save|сохранить|guardar|enregistrer|speichern|salva|salvar|保存)$/i,
      unsave: /^(remove|удалить|eliminar|supprimer|entfernen|rimuovi|remover|削除)$/i
    };

    const re = matchers[action];
    if (!re) {
      await sendBg({ type: 'BG_TASK_DONE', ok: false });
      return true;
    }

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      document.querySelectorAll('video').forEach((v) => {
        try {
          v.muted = true;
          if (!v.paused) v.pause();
        } catch {
          // ignore
        }
      });

      const svgs = Array.from(document.querySelectorAll('svg'));
      for (const svg of svgs) {
        const lbl = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '').trim();
        if (re.test(lbl)) {
          const btn = svg.closest('[role="button"], button');
          if (btn) {
            btn.click();
            clearInterval(timer);
            setTimeout(() => {
              sendBg({ type: 'BG_TASK_DONE', ok: true });
            }, 950);
            return;
          }
        }
      }

      if (attempts >= 28) {
        clearInterval(timer);
        sendBg({ type: 'BG_TASK_DONE', ok: false });
      }
    }, 250);

    return true;
  }

  runBackgroundTaskIfAssigned().then((isBgTask) => {
    if (isBgTask) return;
    if (!initMiniActionPopupIfNeeded()) {
      loadSettings();
      updateLauncherVisibility();
    }
  });
})();
