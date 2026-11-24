const MUTATIONS_KEY = 'idrWebRequestMutations';

// Pending silent background-tab tasks: tabId -> { action, resolve, timeout }
const bgTasks = new Map();

// Pending webRequest bodies keyed by requestId so we can pair with headers if needed
const learned = {
  like: null,
  unlike: null,
  save: null,
  unsave: null
};

chrome.storage.local.get([MUTATIONS_KEY], (res) => {
  const saved = res?.[MUTATIONS_KEY];
  if (saved) {
    for (const k of ['like', 'unlike', 'save', 'unsave']) {
      if (saved[k]) learned[k] = saved[k];
    }
  }
});

function saveLearned() {
  chrome.storage.local.set({ [MUTATIONS_KEY]: learned });
}

function classifyFriendly(friendly) {
  const f = (friendly || '').toLowerCase();
  if (!f || f.includes('comment') || f.includes('story') || f.endsWith('query')) return null;
  if (f.includes('unlike')) return 'unlike';
  if (f.includes('like') && !f.includes('likers') && !f.includes('liked')) return 'like';
  if (f.includes('unsave') || (f.includes('remove') && f.includes('collection'))) return 'unsave';
  if (f.includes('save') && !f.includes('saved_')) return 'save';
  return null;
}

// Observe ALL Instagram POST requests via chrome.webRequest (sees fetch, XHR, workers — everything!)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    const url = details.url || '';

    try {
      // 1. GraphQL mutations
      if (url.includes('/graphql') && details.requestBody?.formData) {
        const fd = details.requestBody.formData;
        const friendly = fd.fb_api_req_friendly_name?.[0] || '';
        const variables = fd.variables?.[0] || '';
        const docId = fd.doc_id?.[0] || '';
        const pkMatch = variables.match(/(\d{15,22})/);

        const kind = classifyFriendly(friendly);
        if (kind && docId && pkMatch) {
          // Serialize full formData so main tab can replay with fresh session tokens
          const params = new URLSearchParams();
          for (const [k, vals] of Object.entries(fd)) {
            if (Array.isArray(vals) && vals.length > 0) {
              params.set(k, vals[0]);
            }
          }
          learned[kind] = {
            kind: 'graphql',
            url,
            friendly,
            docId,
            body: params.toString(),
            origPk: pkMatch[1]
          };
          saveLearned();
        }
        return;
      }

      // 2. REST endpoints (if Instagram uses REST for like/save)
      const restMatch = url.match(/^(https?:\/\/[^/]+)?(\/[^?#]*\/)(\d+)(?:_\d+)?\/(like|unlike|save|unsave)\/?(\?.*)?$/i);
      if (restMatch) {
        const kind = restMatch[4].toLowerCase();
        learned[kind] = {
          kind: 'rest',
          url: url.replace(restMatch[3], '{PK}'),
          origPk: restMatch[3]
        };
        saveLearned();
      }
    } catch {
      // ignore
    }
  },
  {
    urls: ['https://www.instagram.com/graphql/*', 'https://www.instagram.com/api/v1/*']
  },
  ['requestBody']
);

async function runSilentBackgroundAction(code, action) {
  if (!code || !action) return { ok: false };
  const url = `https://www.instagram.com/reels/${code}/`;

  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        resolve({ ok: false });
        return;
      }
      const tabId = tab.id;
      chrome.tabs.update(tabId, { muted: true }).catch(() => {});

      const timeout = setTimeout(() => {
        if (bgTasks.has(tabId)) {
          bgTasks.delete(tabId);
          chrome.tabs.remove(tabId).catch(() => {});
          resolve({ ok: false, timeout: true });
        }
      }, 10000);

      bgTasks.set(tabId, { action, resolve, timeout });
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const task = bgTasks.get(tabId);
  if (task) {
    clearTimeout(task.timeout);
    bgTasks.delete(tabId);
    task.resolve({ ok: false, closed: true });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'GET_LEARNED_MUTATION') {
    sendResponse({ mutation: learned[msg.action] || null });
    return true;
  }

  if (msg.type === 'RUN_SILENT_ACTION') {
    runSilentBackgroundAction(msg.code, msg.action).then((res) => sendResponse(res));
    return true;
  }

  if (msg.type === 'GET_BG_TASK') {
    const tabId = sender?.tab?.id;
    const task = tabId ? bgTasks.get(tabId) : null;
    sendResponse(task ? { action: task.action } : { action: null });
    return true;
  }

  if (msg.type === 'BG_TASK_DONE') {
    const tabId = sender?.tab?.id;
    const task = tabId ? bgTasks.get(tabId) : null;
    if (task) {
      clearTimeout(task.timeout);
      bgTasks.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
      task.resolve({ ok: Boolean(msg.ok) });
    }
    sendResponse({ ok: true });
    return true;
  }
});
