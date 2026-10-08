// AgentDesk — main process
// Satu-satunya tempat yang memegang API key & antrean request ke 9Router.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'agentdesk-config.json');

function normalizeConfig(c) {
  const cfg = {
    baseUrl: 'http://127.0.0.1:20128',
    model: 'muse-spark',
    maxTokens: 600,
    temperature: 0.7,
    apiKey: '',
    ...(c || {}),
  };
  // baseUrl selalu origin tanpa /v1 (path /v1/... ditambahkan per-request)
  cfg.baseUrl = String(cfg.baseUrl || 'http://127.0.0.1:20128').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return cfg;
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return normalizeConfig({});
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ---- Antrean request: bridge hanya punya 1 worker (~13 detik/request).
// Semua completion diserialkan di sini supaya tidak 504 massal.
const queue = [];
let busy = false;

async function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift();
  try {
    const result = await doCompletion(job);
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    busy = false;
    setImmediate(pump);
  }
}

async function doCompletion(job) {
  const cfg = loadConfig();
  const ctrl = new AbortController();
  job.abort = () => ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        messages: job.messages,
      }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('HTTP ' + res.status + ' — respons bukan JSON: ' + text.slice(0, 160)); }
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 200);
      throw new Error('HTTP ' + res.status + ' — ' + msg);
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    return { content: content || '(respon kosong)', queueWaitMs: job.waitMs };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout 90 detik — bridge/worker kemungkinan macet. Coba lagi.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161b',
    title: 'AgentDesk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', () => {
    const c = loadConfig();
    return { ...c, apiKey: c.apiKey ? '••••••••' : '' };
  });
  ipcMain.handle('config:hasKey', () => !!loadConfig().apiKey);
  ipcMain.handle('config:set', (_e, patch) => {
    const cfg = normalizeConfig({ ...loadConfig(), ...patch });
    saveConfig(cfg);
    return { ok: true };
  });
  ipcMain.handle('chat:send', (_e, payload) => new Promise((resolve, reject) => {
    const job = { messages: payload.messages, enqueuedAt: Date.now(), resolve, reject, abort: null };
    job.waitMs = 0;
    const origResolve = resolve, origReject = reject;
    job.resolve = (r) => { r.queueWaitMs = Date.now() - job.enqueuedAt; origResolve(r); };
    job.reject = origReject;
    queue.push(job);
    setImmediate(pump);
  }));
  ipcMain.handle('chat:queueInfo', () => ({ pending: queue.length, busy }));
  ipcMain.handle('chat:cancelAll', () => {
    const n = queue.length;
    queue.splice(0).forEach(j => j.reject(new Error('Dibatalkan pengguna.')));
    return { cancelled: n };
  });
  ipcMain.handle('conn:test', async () => {
    const cfg = loadConfig();
    if (!cfg.apiKey) throw new Error('API key belum diisi — buka Pengaturan dulu.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/models', {
        signal: ctrl.signal,
        headers: { Authorization: 'Bearer ' + cfg.apiKey },
      });
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + text.slice(0, 160));
      return { ok: true, detail: text.slice(0, 120) };
    } finally { clearTimeout(timer); }
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
