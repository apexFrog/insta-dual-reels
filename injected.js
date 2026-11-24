(() => {
  if (window.__IDR_INJECTED__) return;
  window.__IDR_INJECTED__ = true;

  const seenKeys = new Set();
  const buffer = [];

  const MUTATION_STORE_KEY = '__idr_learned_mutations_v1';

  // Self-learned official GraphQL templates (shared across tabs/popups via localStorage)
  const learnedMutations = {
    like: null,
    unlike: null,
    save: null,
    unsave: null
  };

  // Fresh auth tokens captured from any GraphQL request in the current tab
  const liveGraphqlTokens = {
    fb_dtsg: '',
    lsd: '',
    jazoest: '',
    csrftoken: ''
  };

  function loadLearnedMutations() {
    try {
      const raw = localStorage.getItem(MUTATION_STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const k of ['like', 'unlike', 'save', 'unsave']) {
        if (parsed?.[k]?.url && parsed?.[k]?.body) {
          learnedMutations[k] = parsed[k];
        }
      }
    } catch {
      // ignore
    }
  }

  function saveLearnedMutations() {
    try {
      localStorage.setItem(MUTATION_STORE_KEY, JSON.stringify(learnedMutations));
    } catch {
      // ignore
    }
  }

  loadLearnedMutations();
  window.addEventListener('storage', (e) => {
    if (e.key === MUTATION_STORE_KEY) loadLearnedMutations();
  });

  function isReelsPage() {
    return /instagram\.com\/reels(\/|$|\?)/i.test(location.href);
  }

  function normalizePk(raw) {
    if (!raw) return '';
    const part = String(raw).split('_')[0].trim();
    return /^\d+$/.test(part) ? part : '';
  }

  function decodeXmlEntities(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function extractDashAudioUrl(manifestXml) {
    if (!manifestXml || typeof manifestXml !== 'string') return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(manifestXml, 'application/xml');
      const sets = Array.from(doc.getElementsByTagName('AdaptationSet'));
      for (const set of sets) {
        const mime = (set.getAttribute('mimeType') || '').toLowerCase();
        const contentType = (set.getAttribute('contentType') || '').toLowerCase();
        if (mime.includes('audio') || contentType === 'audio') {
          const baseUrls = set.getElementsByTagName('BaseURL');
          if (baseUrls.length > 0 && baseUrls[0].textContent) {
            return baseUrls[0].textContent.trim();
          }
        }
      }
      const reps = Array.from(doc.getElementsByTagName('Representation'));
      for (const rep of reps) {
        const mime = (rep.getAttribute('mimeType') || '').toLowerCase();
        if (mime.includes('audio')) {
          const baseUrls = rep.getElementsByTagName('BaseURL');
          if (baseUrls.length > 0 && baseUrls[0].textContent) {
            return baseUrls[0].textContent.trim();
          }
        }
      }
    } catch {
      const m = manifestXml.match(/mimeType="audio\/[^"]*"[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i);
      if (m && m[1]) return decodeXmlEntities(m[1].trim());
    }
    return '';
  }

  function extractReelItem(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const vv = obj.video_versions;
    if (!Array.isArray(vv) || vv.length === 0) return null;

    const bestVideo = vv.find((v) => v && typeof v.url === 'string' && v.url.startsWith('http')) || vv[0];
    if (!bestVideo?.url) return null;

    const pk = normalizePk(obj.pk) || normalizePk(obj.id) || normalizePk(obj.media_id);
    const code = typeof obj.code === 'string' ? obj.code : '';
    if (!pk && !code) return null;

    const manifest =
      obj.video_dash_manifest ||
      obj.dash_info?.video_dash_manifest ||
      obj.video_dash_manifest_str ||
      '';
    const audioUrl = extractDashAudioUrl(manifest);

    const user = obj.user || obj.owner || {};
    const posterCandidates = obj.image_versions2?.candidates;
    const posterUrl = Array.isArray(posterCandidates) && posterCandidates[0]?.url ? posterCandidates[0].url : '';

    return {
      id: pk || code,
      pk: pk || '',
      code,
      videoUrl: bestVideo.url,
      audioUrl,
      posterUrl,
      username: user.username || '',
      fullName: user.full_name || '',
      avatarUrl: user.profile_pic_url || '',
      isVerified: Boolean(user.is_verified),
      caption: typeof obj.caption === 'string' ? obj.caption : obj.caption?.text || '',
      likeCount: typeof obj.like_count === 'number' ? obj.like_count : null,
      commentCount: typeof obj.comment_count === 'number' ? obj.comment_count : null,
      hasLiked: Boolean(obj.has_liked),
      hasSaved: Boolean(obj.has_viewer_saved)
    };
  }

  function walkForReels(root, out, depth = 0) {
    if (!root || typeof root !== 'object' || depth > 22) return;

    if (Array.isArray(root)) {
      for (let i = 0; i < root.length; i++) {
        walkForReels(root[i], out, depth + 1);
      }
      return;
    }

    if (Array.isArray(root.video_versions) && root.video_versions.length > 0) {
      const item = extractReelItem(root);
      if (item) {
        const keyPk = item.pk ? `pk:${item.pk}` : '';
        const keyCode = item.code ? `code:${item.code}` : '';
        if ((!keyPk || !seenKeys.has(keyPk)) && (!keyCode || !seenKeys.has(keyCode))) {
          if (keyPk) seenKeys.add(keyPk);
          if (keyCode) seenKeys.add(keyCode);
          out.push(item);
        }
      }
      return;
    }

    const keys = Object.keys(root);
    for (let i = 0; i < keys.length; i++) {
      const val = root[keys[i]];
      if (val && typeof val === 'object') {
        walkForReels(val, out, depth + 1);
      }
    }
  }

  function emitReels(items) {
    if (!items || items.length === 0) return;
    for (const item of items) {
      buffer.push(item);
    }
    window.dispatchEvent(new CustomEvent('idr-reels-found', { detail: items }));
  }

  function parseTextForReels(text) {
    if (!text || !text.includes('video_versions')) return;
    const found = [];

    let cleaned = text.trim();
    if (cleaned.startsWith('for (;;);')) {
      cleaned = cleaned.slice(9).trim();
    }

    try {
      const json = JSON.parse(cleaned);
      walkForReels(json, found);
    } catch {
      const lines = cleaned.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('video_versions')) continue;
        try {
          const chunk = JSON.parse(trimmed);
          walkForReels(chunk, found);
        } catch {
          // ignore
        }
      }
    }

    emitReels(found);
  }

  function cloneHeaders(headersInit) {
    const out = {};
    if (!headersInit) return out;
    if (headersInit instanceof Headers) {
      headersInit.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(headersInit)) {
      for (const [k, v] of headersInit) out[k.toLowerCase()] = v;
    } else if (typeof headersInit === 'object') {
      for (const k of Object.keys(headersInit)) out[k.toLowerCase()] = headersInit[k];
    }
    delete out['content-length'];
    return out;
  }

  function bodyToString(body) {
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    return '';
  }

  // Passively learn Instagram's OWN official Like/Save requests (GraphQL or REST, string or URLSearchParams)
  function maybeLearnMutation(url, method, headers, rawBody) {
    if (!url || (method || '').toUpperCase() !== 'POST') return;
    const body = bodyToString(rawBody);

    try {
      // Case 1: GraphQL mutation
      if (url.includes('/graphql') && body) {
        const params = new URLSearchParams(body);
        if (params.get('fb_dtsg')) liveGraphqlTokens.fb_dtsg = params.get('fb_dtsg');
        if (params.get('lsd')) liveGraphqlTokens.lsd = params.get('lsd');
        if (params.get('jazoest')) liveGraphqlTokens.jazoest = params.get('jazoest');
        if (headers['x-csrftoken']) liveGraphqlTokens.csrftoken = headers['x-csrftoken'];

        const friendly = (
          headers['x-fb-friendly-name'] ||
          params.get('fb_api_req_friendly_name') ||
          ''
        ).toLowerCase();
        const rawVars = params.get('variables') || '';
        const pkMatch = rawVars.match(/(\d{15,22})/);

        if (!friendly || !rawVars || !pkMatch) return;
        if (friendly.includes('comment') || friendly.includes('story') || friendly.endsWith('query')) return;

        let matched = null;
        if (friendly.includes('unlike')) {
          matched = 'unlike';
        } else if (friendly.includes('like') && !friendly.includes('likers') && !friendly.includes('liked')) {
          matched = 'like';
        } else if (friendly.includes('unsave') || (friendly.includes('remove') && friendly.includes('collection'))) {
          matched = 'unsave';
        } else if (friendly.includes('save') && !friendly.includes('saved_')) {
          matched = 'save';
        }

        if (matched) {
          learnedMutations[matched] = { kind: 'graphql', url, headers, body, origPk: pkMatch[1] };
          saveLearnedMutations();
          window.postMessage({ __idr: true, dir: 'MAIN_TO_ISO', learned: matched }, '*');
        }
        return;
      }

      // Case 2: Native REST endpoint (e.g. /api/v1/.../{pk}/like/ or /web/.../{pk}/save/)
      const restMatch = url.match(/^(https?:\/\/[^/]+)?(\/[^?#]*\/)(\d+)(?:_\d+)?\/(like|unlike|save|unsave)\/?(\?.*)?$/i);
      if (restMatch) {
        const actionType = restMatch[4].toLowerCase();
        const urlTemplate = url.replace(restMatch[3], '{PK}');
        learnedMutations[actionType] = { kind: 'rest', url: urlTemplate, headers, body };
        saveLearnedMutations();
        window.postMessage({ __idr: true, dir: 'MAIN_TO_ISO', learned: actionType }, '*');
      }
    } catch {
      // ignore
    }
  }

  function scanScriptTags() {
    if (!isReelsPage()) return;
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      if (s.dataset.idrScanned) continue;
      const txt = s.textContent;
      if (txt && txt.includes('video_versions')) {
        s.dataset.idrScanned = '1';
        parseTextForReels(txt);
      }
    }
  }

  // Passive read-only fetch observer
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const reqInit = args[1] || null;

    try {
      if (reqInit && (reqInit.method || '').toUpperCase() === 'POST') {
        const hdrs = {
          ...cloneHeaders(args[0]?.headers),
          ...cloneHeaders(reqInit.headers)
        };
        maybeLearnMutation(reqUrl, reqInit.method, hdrs, reqInit.body);
      }
    } catch {
      // ignore
    }

    const promise = origFetch.apply(this, args);

    try {
      if (
        isReelsPage() &&
        (reqUrl.includes('/graphql') ||
          reqUrl.includes('/api/v1/clips') ||
          reqUrl.includes('/api/v1/feed'))
      ) {
        promise
          .then((resp) => {
            if (!resp || !resp.ok) return;
            const ct = resp.headers?.get('content-type') || '';
            if (!ct.includes('json') && !ct.includes('text') && !ct.includes('javascript')) return;
            resp
              .clone()
              .text()
              .then((txt) => parseTextForReels(txt))
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return promise;
  };

  // Passive read-only XHR observer (always forwards `arguments` untouched!)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__idrMethod = method;
    this.__idrUrl = typeof url === 'string' ? url : '';
    this.__idrHeaders = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__idrHeaders && k) this.__idrHeaders[String(k).toLowerCase()] = v;
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if ((this.__idrMethod || '').toUpperCase() === 'POST') {
        maybeLearnMutation(this.__idrUrl, this.__idrMethod, this.__idrHeaders || {}, body);
      }
    } catch {
      // ignore
    }

    this.addEventListener('load', () => {
      try {
        const url = this.__idrUrl || '';
        if (
          isReelsPage() &&
          (url.includes('/graphql') ||
            url.includes('/api/v1/clips') ||
            url.includes('/api/v1/feed'))
        ) {
          if (typeof this.responseText === 'string') {
            parseTextForReels(this.responseText);
          }
        }
      } catch {
        // ignore
      }
    });
    return origSend.apply(this, arguments);
  };

  // Replay ONLY an exact self-learned official GraphQL or REST mutation with fresh tokens
  async function replayLearnedMutation(type, pk, externalTpl = null) {
    loadLearnedMutations();
    const tpl = externalTpl || learnedMutations[type];
    if (!tpl || !pk) return { ok: false, unlearned: true };

    try {
      const csrfMatch = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      const freshCsrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : liveGraphqlTokens.csrftoken;
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-ig-app-id': '936619743392459',
        'x-requested-with': 'XMLHttpRequest',
        ...(tpl.headers || {})
      };
      if (freshCsrf) headers['x-csrftoken'] = freshCsrf;
      if (liveGraphqlTokens.lsd) headers['x-fb-lsd'] = liveGraphqlTokens.lsd;
      if (tpl.friendly && !headers['x-fb-friendly-name']) {
        headers['x-fb-friendly-name'] = tpl.friendly;
      }

      // Case 1: Learned REST endpoint
      if (tpl.kind === 'rest' || tpl.url.includes('{PK}')) {
        const targetUrl = tpl.url.replace('{PK}', String(pk));
        const resp = await origFetch(targetUrl, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: tpl.body || ''
        });
        return { ok: resp.ok, status: resp.status };
      }

      // Case 2: Learned GraphQL mutation
      const params = new URLSearchParams(tpl.body);
      const rawVars = params.get('variables');
      if (!rawVars) return { ok: false };

      let updatedVarsStr = '';
      if (tpl.origPk && rawVars.includes(tpl.origPk)) {
        updatedVarsStr = rawVars.split(tpl.origPk).join(String(pk));
      } else {
        const vars = JSON.parse(rawVars);
        let replaced = false;
        const setMediaId = (obj) => {
          if (!obj || typeof obj !== 'object') return false;
          for (const k of Object.keys(obj)) {
            if (k === 'media_id' || k === 'mediaId' || k === 'id' || k === 'pk') {
              if (/^\d+(_\d+)?$/.test(String(obj[k]))) {
                obj[k] = String(pk);
                return true;
              }
            }
            if (typeof obj[k] === 'object' && setMediaId(obj[k])) return true;
          }
          return false;
        };

        if ('media_id' in vars) {
          vars.media_id = String(pk);
          replaced = true;
        } else if ('mediaId' in vars) {
          vars.mediaId = String(pk);
          replaced = true;
        } else {
          replaced = setMediaId(vars);
        }
        if (!replaced) return { ok: false };
        updatedVarsStr = JSON.stringify(vars);
      }

      params.set('variables', updatedVarsStr);
      if (liveGraphqlTokens.fb_dtsg) params.set('fb_dtsg', liveGraphqlTokens.fb_dtsg);
      if (liveGraphqlTokens.lsd) params.set('lsd', liveGraphqlTokens.lsd);
      if (liveGraphqlTokens.jazoest) params.set('jazoest', liveGraphqlTokens.jazoest);

      const resp = await origFetch(tpl.url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: params.toString()
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      const txt = await resp.text();
      if (txt.includes('"errors"') && !txt.includes('"data"')) {
        return { ok: false, status: resp.status };
      }
      return { ok: true, status: resp.status };
    } catch {
      return { ok: false };
    }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__idr || d.dir !== 'ISO_TO_MAIN') return;

    const { reqId, action, payload } = d;
    let result = { ok: false };
    if (action === 'REPLAY_MUTATION') {
      result = await replayLearnedMutation(payload?.type, normalizePk(payload?.pk), payload?.externalTpl || null);
    }
    window.postMessage({ __idr: true, dir: 'MAIN_TO_ISO', reqId, result }, '*');
  });

  window.addEventListener('idr-request-buffer', () => {
    scanScriptTags();
    if (buffer.length > 0 && isReelsPage()) {
      window.dispatchEvent(new CustomEvent('idr-reels-found', { detail: buffer.slice() }));
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanScriptTags, { once: true });
  } else {
    scanScriptTags();
  }
  window.addEventListener('load', scanScriptTags, { once: true });
})();
