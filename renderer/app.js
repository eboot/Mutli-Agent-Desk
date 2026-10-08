// AgentDesk — renderer: daftar agen, chat, dan routing pesan antar-agen.
'use strict';

const LS_AGENTS = 'agentdesk.agents.v1';
const LS_CHATS = 'agentdesk.chats.v1';
const LS_ACTIVE = 'agentdesk.active.v1';
const LS_DEVICE = 'agentdesk.device.v1';
const LS_KON = 'agentdesk.konektor.v1';

// Identitas perangkat ini (untuk Konektor antar-perangkat)
let device = load(LS_DEVICE, null) || {
  id: (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now().toString(36)),
  name: 'Perangkat-' + Math.random().toString(36).slice(2, 6),
};
let kon = load(LS_KON, { enabled: false, key: '', relay: 'https://kabe9router.pages.dev', lastInboxId: 0 });
kon.relay = (kon.relay || 'https://kabe9router.pages.dev').replace(/\/$/, '');
let remoteDevices = []; // cache hasil /devices

const CHIEF_BRIEF = `Kamu adalah CHIEF, koordinator tim agen AI di aplikasi AgentDesk.
Tim kamu: research (riset), dev (ngoding), qa (testing/review), ops (operasional/deploy).
Aturan main:
- Tugas koordinasi ada di kamu. Tugas eksekusi di mereka — mereka yang lapor sendiri, bukan lewat kamu.
- Untuk mendelegasikan ke agen lain, tulis tag persis seperti ini di jawabanmu:
  [[KIRIM:nama_agen]] isi pesan untuk agen itu
  Contoh: [[KIRIM:dev]] tolong buatkan fungsi login dengan validasi email.
  Aplikasi otomatis meneruskan pesan itu ke chat agen tersebut, dan balasan mereka otomatis kembali ke chat ini.
- Boleh kirim ke beberapa agen sekaligus dengan beberapa tag.
- Lintas perangkat: kalau Konektor aktif dan ada perangkat lain online (panel 🔗 Konektor),
  gunakan [[KIRIM:nama_agen@NamaPerangkat]] — contoh: [[KIRIM:dev@Laptop]] tolong review kode ini.
  Balasan mereka otomatis kembali ke chat ini.
- Jangan mengarang balasan mereka — tunggu balasan asli yang masuk sebagai "📨 [Dari nama_agen]".
- Jawab ringkas, Bahasa Indonesia santai.`;

function seedAgents() {
  return [
    { id: 'chief', name: 'Chief', icon: '🎯', color: '#e5484d', autoReply: true,
      system: CHIEF_BRIEF },
    { id: 'research', name: 'research', icon: '🔬', color: '#4f8cff', autoReply: true,
      system: `Kamu adalah RESEARCH, agen riset di tim AgentDesk (koordinator: Chief).
Tugasmu: mencari informasi, merangkum sumber, membandingkan opsi, memberi rekomendasi berbasis data.
Kamu bisa menerima pesan terusan dari agen lain — pesan itu diawali "📨 [Dari nama_agen]". Perlakukan sebagai instruksi kerja dan jawab langsung ke intinya.
Kalau butuh mendelegasikan balik, gunakan tag [[KIRIM:nama_agen]] pesan. Jawab ringkas, Bahasa Indonesia santai.` },
    { id: 'dev', name: 'dev', icon: '💻', color: '#30a46c', autoReply: true,
      system: `Kamu adalah DEV, agen programmer di tim AgentDesk (koordinator: Chief).
Tugasmu: menulis/menjelaskan kode, debugging, review kode, merancang arsitektur.
Kamu bisa menerima pesan terusan dari agen lain — pesan itu diawali "📨 [Dari nama_agen]". Perlakukan sebagai tiket kerja dan kerjakan langsung.
Kalau butuh mendelegasikan balik, gunakan tag [[KIRIM:nama_agen]] pesan. Jawab ringkas, Bahasa Indonesia santai. Kode dalam blok code.` },
    { id: 'qa', name: 'qa', icon: '🧪', color: '#f5a524', autoReply: true,
      system: `Kamu adalah QA, agen quality assurance di tim AgentDesk (koordinator: Chief).
Tugasmu: menguji logika, mencari bug/edge-case, me-review hasil kerja dev, membuat checklist pengujian.
Kamu bisa menerima pesan terusan dari agen lain — pesan itu diawali "📨 [Dari nama_agen]". Perlakukan sebagai permintaan testing dan jawab dengan temuan konkret.
Kalau butuh mendelegasikan balik, gunakan tag [[KIRIM:nama_agen]] pesan. Jawab ringkas, Bahasa Indonesia santai.` },
    { id: 'ops', name: 'ops', icon: '🛠️', color: '#8e4ec6', autoReply: true,
      system: `Kamu adalah OPS, agen operasional di tim AgentDesk (koordinator: Chief).
Tugasmu: urusan deploy, server, cron, monitoring, dan langkah operasional step-by-step.
Kamu bisa menerima pesan terusan dari agen lain — pesan itu diawali "📨 [Dari nama_agen]". Perlakukan sebagai permintaan operasional dan jawab dengan langkah konkret.
Kalau butuh mendelegasikan balik, gunakan tag [[KIRIM:nama_agen]] pesan. Jawab ringkas, Bahasa Indonesia santai.` },
  ];
}

let agents = load(LS_AGENTS, null) || seedAgents();
let chats = load(LS_CHATS, {});
let activeId = localStorage.getItem(LS_ACTIVE) || 'chief';
let waiting = false;      // ada request yang jalan / antre
let waitTimer = null;

function load(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } }
function persist() {
  localStorage.setItem(LS_AGENTS, JSON.stringify(agents));
  localStorage.setItem(LS_CHATS, JSON.stringify(chats));
  localStorage.setItem(LS_ACTIVE, activeId);
  localStorage.setItem(LS_DEVICE, JSON.stringify(device));
  localStorage.setItem(LS_KON, JSON.stringify(kon));
}
const agentById = (id) => agents.find(a => a.id === id);
const chatOf = (id) => (chats[id] = chats[id] || []);

// ---------- Markdown-lite ----------
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function md(s) {
  const blocks = [];
  s = esc(s).replace(/```([\s\S]*?)```/g, (m, code) => {
    blocks.push('<pre><code>' + code.replace(/^\n/, '') + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
       .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
  return s;
}
const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 5);

// ---------- Sidebar ----------
function renderSidebar(filter = '') {
  const list = document.getElementById('agent-list');
  list.innerHTML = '';
  const q = filter.trim().toLowerCase();
  agents.filter(a => a.name.toLowerCase().includes(q)).forEach(a => {
    const c = chatOf(a.id);
    const last = c[c.length - 1];
    const unread = c.filter(m => m.unread).length;
    const el = document.createElement('div');
    el.className = 'agent-item' + (a.id === activeId ? ' active' : '');
    el.innerHTML =
      '<span class="avatar" style="border-color:' + a.color + '">' + esc(a.icon) + '</span>' +
      '<div class="agent-meta"><div class="agent-name">' + esc(a.name) +
        (unread ? ' <span class="badge">' + unread + '</span>' : '') + '</div>' +
        '<div class="agent-preview">' + esc(last ? last.content.slice(0, 40) : 'Belum ada percakapan') + '</div></div>' +
      '<span class="agent-time">' + (last ? fmtTime(last.ts) : '') + '</span>';
    el.onclick = () => selectAgent(a.id);
    list.appendChild(el);
  });
}

function selectAgent(id) {
  activeId = id;
  chats[id] = chatOf(id).map(m => ({ ...m, unread: false }));
  persist();
  renderSidebar(document.getElementById('search').value);
  renderHeader();
  renderMessages();
}

// ---------- Header & messages ----------
function renderHeader() {
  const a = agentById(activeId);
  if (!a) return;
  document.getElementById('header-avatar').textContent = a.icon;
  document.getElementById('header-avatar').style.borderColor = a.color;
  document.getElementById('header-name').textContent = a.name;
}

function renderMessages() {
  const box = document.getElementById('messages');
  box.innerHTML = '';
  chatOf(activeId).forEach((m, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'assistant');
    let html = '';
    if (m.via) html += '<span class="via-tag">📨 [Dari ' + esc(m.via) + ']</span>';
    html += '<div class="bubble">' + md(m.content) + '</div>';
    html += '<div class="meta"><span>' + fmtTime(m.ts) + '</span>';
    if (m.role !== 'error') html += '<button class="fwd-btn" data-idx="' + idx + '" title="Teruskan ke agen lain">➡️ teruskan</button>';
    if (m.role === 'error' && idx === chatOf(activeId).length - 1) html += '<button class="btn small retry-btn">🔁 Coba lagi</button>';
    html += '</div>';
    wrap.innerHTML = html;
    box.appendChild(wrap);
  });
  const fwd = box.querySelectorAll('.fwd-btn');
  fwd.forEach(b => b.onclick = () => openForwardModal(+b.dataset.idx));
  const retry = box.querySelector('.retry-btn');
  if (retry) retry.onclick = retryLast;
  box.scrollTop = box.scrollHeight;
}

function pushMsg(agentId, role, content, extra = {}) {
  const m = { role, content, ts: Date.now(), ...extra };
  if (agentId !== activeId && (role === 'assistant' || role === 'user')) m.unread = true;
  chatOf(agentId).push(m);
  persist();
  if (agentId === activeId) renderMessages(); else renderSidebar(document.getElementById('search').value);
  return m;
}

// ---------- Routing antar-agen ----------
const MAX_HOPS = 4;
// Delegasi: "[[KIRIM:dev]] pesan" -> kirim ke dev, balasan dev kembali ke pengirim.
function extractDelegations(text) {
  const out = [];
  const re = /\[\[KIRIM:([a-zA-Z0-9_\-@]+)\]\]\s*([\s\S]*?)(?=\[\[KIRIM:|$)/g;
  let m;
  while ((m = re.exec(text))) out.push({ target: m[1].toLowerCase(), body: m[2].trim() });
  return out;
}
const cleanTags = (t) => t.replace(/\[\[KIRIM:[a-zA-Z0-9_\-@]+\]\]/g, '').trim();

function deliverMessage(fromId, targetId, body, opts = {}) {
  // --- Cabang lintas-perangkat: target "agen@NamaPerangkat"
  const at = targetId.indexOf('@');
  if (at > 0) {
    if (!kon.enabled) { pushMsg(fromId, 'error', '⚠️ Konektor belum aktif — nyalakan di panel 🔗 Konektor.'); return; }
    const agentName = targetId.slice(0, at);
    const devName = targetId.slice(at + 1);
    const dev = remoteDevices.find(d => d.name.toLowerCase() === devName);
    if (!dev) { pushMsg(fromId, 'error', '⚠️ Perangkat "' + devName + '" tidak online. Cek panel 🔗 Konektor.'); return; }
    const ra = (dev.agents || []).find(a => (a.id || '').toLowerCase() === agentName || (a.name || '').toLowerCase() === agentName);
    if (!ra) { pushMsg(fromId, 'error', '⚠️ Agen "' + agentName + '" tidak ada di ' + dev.name + '.'); return; }
    const from = agentById(fromId);
    sendRemote(fromId, dev.device_id, ra.id || ra.name, body).then(() => {
      pushMsg(fromId, 'assistant', '🌐 Terkirim ke ' + dev.name + ' / ' + (ra.name || ra.id) + ' — menunggu balasan…', { via: 'konektor' });
    }).catch(e => pushMsg(fromId, 'error', '⚠️ Gagal kirim ke ' + dev.name + ': ' + e.message));
    return;
  }
  // --- Cabang lokal (sama seperti sebelumnya)
  const target = agentById(targetId);
  const from = agentById(fromId);
  if (!target) { pushMsg(fromId, 'error', '⚠️ Agen "' + targetId + '" tidak ditemukan.'); return; }
  const hops = (opts.hops || 0) + 1;
  if (hops > MAX_HOPS) { pushMsg(fromId, 'error', '⚠️ Rantai delegasi terlalu dalam (>' + MAX_HOPS + ') — dihentikan agar tidak loop.'); return; }
  const via = [...(opts.via || []), fromId];
  if (via.filter(v => v === targetId).length > 1) { pushMsg(fromId, 'error', '⚠️ Delegasi ke ' + target.name + ' dibatalkan (terdeteksi loop).'); return; }
  pushMsg(targetId, 'user', '📨 [Dari ' + from.name + ']:\n' + body, { via: from.name, envelope: { from: fromId, via, hops } });
  // target otomatis menjawab; jawabannya dikembalikan ke pengirim (sekali, tanpa auto-lanjut)
  if (target.autoReply !== false) {
    setTimeout(() => agentTurn(targetId, { replyTo: fromId, envelope: { from: fromId, via, hops }, silent: false }), 400);
  }
}

// ---------- Konektor antar-perangkat (relay via Pages Functions + D1) ----------
async function konektorApi(path, opts = {}) {
  // Relay Konektor independen dari URL router (tetap via Cloudflare edge).
  const base = (kon.relay || 'https://kabe9router.pages.dev').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (kon.key) headers['x-konektor-key'] = kon.key;
  const res = await fetch(base + '/api/konektor' + path, { ...opts, headers });
  if (!res.ok) throw new Error('Konektor HTTP ' + res.status);
  return res.json();
}

async function sendRemote(fromId, toDevice, toAgent, body, kind = 'task') {
  const from = agentById(fromId);
  await konektorApi('/send', {
    method: 'POST',
    body: JSON.stringify({
      from_device: device.id,
      from_agent: fromId,
      from_label: device.name + '/' + (from ? from.name : fromId),
      to_device: toDevice,
      to_agent: toAgent,
      body,
      kind,
    }),
  });
}

async function konektorHeartbeat() {
  if (!kon.enabled) return;
  try {
    await konektorApi('/register', {
      method: 'POST',
      body: JSON.stringify({
        device_id: device.id,
        name: device.name,
        agents: agents.map(a => ({ id: a.id, name: a.name, icon: a.icon })),
      }),
    });
    const d = await konektorApi('/devices?self=' + encodeURIComponent(device.id));
    remoteDevices = d.devices || [];
  } catch (e) { /* diam — coba lagi siklus berikutnya */ }
}

async function pollInbox() {
  if (!kon.enabled) return;
  try {
    const d = await konektorApi('/inbox?device_id=' + encodeURIComponent(device.id) + '&since=' + kon.lastInboxId);
    for (const m of d.messages || []) {
      kon.lastInboxId = Math.max(kon.lastInboxId, m.id);
      handleRemoteMessage(m);
    }
    persist();
  } catch (e) { /* diam */ }
}

function handleRemoteMessage(m) {
  if (m.from_device === device.id) return; // abaikan gema sendiri
  const agent = agentById(m.to_agent) || agentById('chief') || agents[0];
  pushMsg(agent.id, 'user', '🌐 [Dari ' + m.from_label + ']:\n' + m.body, { via: m.from_label });
  // kind='task' -> agen auto-balas sekali dan balasan dikirim kembali (kind='reply').
  // kind='reply' -> hanya ditampilkan, tidak memicu balasan (anti-loop).
  if (m.kind === 'task' && agent.autoReply !== false) {
    setTimeout(() => agentTurn(agent.id, {
      replyRemote: { to_device: m.from_device, to_agent: m.from_agent },
    }), 800);
  }
}

function konektorDeviceListHtml() {
  if (!kon.enabled) return '<div class="hint">Konektor mati — aktifkan & simpan dulu.</div>';
  if (!remoteDevices.length) return '<div class="hint">Belum ada perangkat lain online.</div>';
  return remoteDevices.map(d =>
    '<div class="agent-pick"><span class="avatar">🌐</span><div><b>' + esc(d.name) + '</b>' +
    '<div class="hint">' + esc((d.agents || []).map(a => a.name || a.id).join(', ') || 'tanpa agen') + '</div></div></div>'
  ).join('');
}

function openKonektorModal() {
  openModal('<h3>🔗 Konektor antar-perangkat</h3>' +
    '<div class="check-row" style="margin-bottom:12px"><input type="checkbox" id="k-on" ' + (kon.enabled ? 'checked' : '') + '>' +
    '<label for="k-on"><b>Aktifkan Konektor</b> — perangkat ini terlihat & bisa dihubungi</label></div>' +
    '<div class="field"><label>Nama perangkat ini</label><input id="k-name" value="' + esc(device.name) + '" maxlength="40"></div>' +
    '<div class="field"><label>ID perangkat (otomatis)</label><input value="' + esc(device.id) + '" readonly></div>' +
    '<div class="field"><label>Kunci konektor (opsional — harus sama di semua perangkat)</label>' +
    '<input id="k-key" type="password" value="' + esc(kon.key) + '" placeholder="kosongkan bila server mode terbuka"></div>' +
    '<div class="field"><label>URL relay Konektor</label><input id="k-relay" value="' + esc(kon.relay) + '"></div>' +
    '<h4 style="margin:6px 0">Perangkat online</h4><div id="k-devlist">' + konektorDeviceListHtml() + '</div>' +
    '<div class="hint">Delegasi lintas perangkat: <b>[[KIRIM:dev@NamaPerangkat]]</b> pesan — balasan otomatis kembali.<br>' +
    'Server perlu di-deploy sekali (lihat KONEKTOR.md di paket konektor-server.zip).</div>' +
    '<div class="modal-actions"><button class="btn" id="k-refresh">🔄 Refresh</button><span style="flex:1"></span>' +
    '<button class="btn" id="m-cancel">Tutup</button><button class="btn primary" id="k-save">Simpan</button></div>');
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('k-refresh').onclick = async () => {
    await konektorHeartbeat();
    document.getElementById('k-devlist').innerHTML = konektorDeviceListHtml();
  };
  document.getElementById('k-save').onclick = async () => {
    kon.enabled = document.getElementById('k-on').checked;
    kon.key = document.getElementById('k-key').value.trim();
    kon.relay = document.getElementById('k-relay').value.trim().replace(/\/$/, '') || 'https://kabe9router.pages.dev';
    const nm = document.getElementById('k-name').value.trim();
    if (nm) device.name = nm;
    persist(); closeModal();
    if (kon.enabled) { await konektorHeartbeat(); pollInbox(); }
  };
}

async function agentTurn(agentId, opts = {}) {
  const agent = agentById(agentId);
  const history = chatOf(agentId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content.replace(/^[📨🌐] \[Dari [^\]]+\]:\n/, '') }));
  const messages = [{ role: 'system', content: agent.system }, ...history].slice(-21);
  setWaiting(true, agent.name);
  try {
    const res = await window.agentDesk.sendChat({ messages });
    const text = res.content;
    pushMsg(agentId, 'assistant', text, opts.envelope ? { via: opts.envelope.via.join(' → ') } : {});
    // Balasan lintas-perangkat: kirim kembali ke pengirim asal (kind='reply' -> tidak auto-balas lagi)
    if (opts.replyRemote) {
      const rr = opts.replyRemote;
      sendRemote(agentId, rr.to_device, rr.to_agent, cleanTags(text), 'reply').catch(() => {});
    }
    // 1) delegasi lanjutan dari jawaban ini
    const env = opts.envelope || { from: null, via: [], hops: 0 };
    extractDelegations(text).forEach(d => deliverMessage(agentId, d.target, d.body || '(tidak ada isi)', { via: env.via, hops: env.hops }));
    // 2) kembalikan balasan ke pengirim delegasi (sekali saja, tanpa auto-reply berantai)
    if (opts.replyTo && agentById(opts.replyTo)) {
      const back = cleanTags(text);
      const ret = { role: 'user', content: '📨 [Dari ' + agent.name + ']:\n' + back, ts: Date.now(), via: agent.name, noAuto: true };
      chats[opts.replyTo] = chatOf(opts.replyTo);
      chats[opts.replyTo].push(ret);
      if (opts.replyTo !== activeId) ret.unread = true;
      persist();
      if (opts.replyTo === activeId) renderMessages(); else renderSidebar(document.getElementById('search').value);
    }
  } catch (e) {
    pushMsg(agentId, 'error', '⚠️ Error: ' + e.message);
  } finally {
    setWaiting(false);
  }
}

function setWaiting(on, agentName = '') {
  waiting = on;
  document.getElementById('typing').classList.toggle('hidden', !on);
  document.getElementById('btn-send').disabled = on;
  document.getElementById('btn-cancel').classList.toggle('hidden', !on);
  const qn = document.getElementById('queue-note');
  if (on) {
    const t0 = Date.now();
    clearInterval(waitTimer);
    document.getElementById('typing-text').textContent = 'Menunggu jawaban ' + agentName + '... 0s';
    waitTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      document.getElementById('typing-text').textContent = 'Menunggu jawaban ' + agentName + '... ' + s + 's';
      window.agentDesk.queueInfo().then(q => {
        qn.classList.toggle('hidden', !(q.busy && q.pending > 0));
        if (q.busy && q.pending > 0) qn.textContent = '⏳ Antrean bridge: ' + q.pending + ' pesan menunggu giliran (bridge memproses satu per satu).';
      }).catch(() => {});
    }, 1000);
  } else {
    clearInterval(waitTimer);
    qn.classList.add('hidden');
  }
}

// ---------- Kirim pesan ----------
async function sendCurrent() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || waiting) return;
  const hasKey = await window.agentDesk.hasKey();
  if (!hasKey) { openSettings(true); return; }
  input.value = '';
  pushMsg(activeId, 'user', text);
  agentTurn(activeId);
}

async function retryLast() {
  if (waiting) return;
  agentTurn(activeId);
}

// ---------- Modal generik ----------
function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-back"><div class="modal">' + html + '</div></div>';
  root.querySelector('.modal-back').addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('modal-back')) closeModal();
  });
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// ---------- Teruskan pesan ----------
function openForwardModal(msgIdx) {
  const msg = chatOf(activeId)[msgIdx];
  const others = agents.filter(a => a.id !== activeId);
  let remoteHtml = '';
  if (kon.enabled && remoteDevices.length) {
    remoteHtml = '<h4 style="margin:12px 0 6px">🌐 Perangkat lain (via Konektor)</h4>' + remoteDevices.map(d =>
      (d.agents || []).map(a =>
        '<div class="agent-pick remote-pick" data-dev="' + esc(d.device_id) + '" data-agent="' + esc(a.id || a.name) +
        '" data-devname="' + esc(d.name) + '" data-agentname="' + esc(a.name || a.id) + '">' +
        '<span class="avatar">🌐</span><b>' + esc(d.name) + ' / ' + esc(a.name || a.id) + '</b></div>'
      ).join('')
    ).join('');
  }
  openModal('<h3>➡️ Teruskan pesan ke...</h3>' +
    '<div class="hint" style="margin-bottom:10px">Pesan diteruskan dan agen tujuan akan langsung menjawab.</div>' +
    others.map(a =>
      '<div class="agent-pick" data-id="' + a.id + '"><span class="avatar" style="border-color:' + a.color + '">' + esc(a.icon) + '</span><b>' + esc(a.name) + '</b></div>'
    ).join('') + remoteHtml +
    '<div class="modal-actions"><button class="btn" id="m-cancel">Batal</button></div>');
  document.getElementById('m-cancel').onclick = closeModal;
  document.querySelectorAll('.agent-pick[data-id]').forEach(el => {
    el.onclick = () => {
      closeModal();
      deliverMessage(activeId, el.dataset.id, msg.content);
      selectAgent(el.dataset.id);
    };
  });
  document.querySelectorAll('.remote-pick').forEach(el => {
    el.onclick = () => {
      closeModal();
      sendRemote(activeId, el.dataset.dev, el.dataset.agent, msg.content).then(() => {
        pushMsg(activeId, 'assistant', '🌐 Terkirim ke ' + el.dataset.devname + ' / ' + el.dataset.agentname + ' — menunggu balasan…', { via: 'konektor' });
      }).catch(e => pushMsg(activeId, 'error', '⚠️ Gagal kirim: ' + e.message));
    };
  });
}

// ---------- CRUD agen ----------
function openAgentModal(existing = null) {
  const a = existing || { id: '', name: '', icon: '🤖', color: '#4f8cff', autoReply: true, system: '' };
  openModal('<h3>' + (existing ? '✏️ Edit agen' : '＋ Agen baru') + '</h3>' +
    '<div class="field"><label>Nama</label><input id="f-name" value="' + esc(a.name) + '" placeholder="cth: dev"></div>' +
    '<div class="field"><label>Icon (emoji)</label><input id="f-icon" value="' + esc(a.icon) + '" maxlength="4"></div>' +
    '<div class="field"><label>Warna</label><input id="f-color" type="color" value="' + esc(a.color) + '"></div>' +
    '<div class="field"><label>System prompt (kepribadian & tugas agen)</label><textarea id="f-system" rows="8" placeholder="Kamu adalah...">' + esc(a.system) + '</textarea></div>' +
    '<div class="check-row"><input type="checkbox" id="f-auto" ' + (a.autoReply !== false ? 'checked' : '') + '><label for="f-auto">Balas otomatis saat menerima pesan terusan</label></div>' +
    '<div class="modal-actions"><button class="btn" id="m-cancel">Batal</button><button class="btn primary" id="m-save">Simpan</button></div>');
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-save').onclick = () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) { alert('Nama wajib diisi.'); return; }
    const data = {
      name,
      icon: document.getElementById('f-icon').value.trim() || '🤖',
      color: document.getElementById('f-color').value,
      system: document.getElementById('f-system').value.trim() || 'Kamu adalah asisten AI yang membantu. Jawab ringkas, Bahasa Indonesia santai.',
      autoReply: document.getElementById('f-auto').checked,
    };
    if (existing) {
      Object.assign(existing, data);
    } else {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);
      agents.push({ id, ...data });
      activeId = id;
    }
    persist(); closeModal();
    renderSidebar(document.getElementById('search').value); renderHeader(); renderMessages();
  };
}

// ---------- Pengaturan ----------
async function openSettings(needKey = false) {
  const cfg = await window.agentDesk.getConfig();
  openModal('<h3>⚙ Pengaturan koneksi</h3>' +
    (needKey ? '<div class="hint" style="color:var(--warn);margin-bottom:10px">Isi API key dulu sebelum chat — key hanya tersimpan di PC ini.</div>' : '') +
    '<div class="field"><label>Base URL (9Router)</label><input id="s-url" value="' + esc(cfg.baseUrl) + '"></div>' +
    '<div class="field"><label>API key 9Router</label><input id="s-key" type="password" placeholder="' + (cfg.apiKey ? '•••••••• (sudah tersimpan)' : 'tempel API key kamu') + '"></div>' +
    '<div class="field"><label>Model</label><input id="s-model" value="' + esc(cfg.model) + '"></div>' +
    '<div class="field"><label>Max tokens</label><input id="s-tokens" type="number" value="' + esc(String(cfg.maxTokens)) + '"></div>' +
    '<div class="hint">Bridge memproses <b>satu request per ±13 detik</b> — aplikasi otomatis mengantrekan. Jangan kirim paralel biar tidak 504.<br>' +
    'Pakai <b>http://127.0.0.1:20128</b> bila 9Router jalan di mesin yang sama dengan aplikasi ini; ' +
    'pakai <b>https://kabe9router.pages.dev</b> bila 9Router ada di mesin lain (via tunnel).</div>' +
    '<div class="modal-actions"><button class="btn" id="m-test">🔌 Tes koneksi</button><span style="flex:1"></span><button class="btn" id="m-cancel">Batal</button><button class="btn primary" id="m-save">Simpan</button></div>' +
    '<div class="hint" id="s-result"></div>');
  document.getElementById('m-cancel').onclick = closeModal;
  document.getElementById('m-save').onclick = async () => {
    const patch = {
      baseUrl: document.getElementById('s-url').value.trim().replace(/\/$/, ''),
      model: document.getElementById('s-model').value.trim(),
      maxTokens: parseInt(document.getElementById('s-tokens').value, 10) || 600,
    };
    const key = document.getElementById('s-key').value.trim();
    if (key) patch.apiKey = key;
    await window.agentDesk.setConfig(patch);
    closeModal();
  };
  document.getElementById('m-test').onclick = async () => {
    const r = document.getElementById('s-result');
    r.textContent = 'Mengetes...';
    try { await window.agentDesk.testConnection(); r.textContent = '✅ Koneksi OK — 9Router merespon.'; }
    catch (e) { r.textContent = '❌ ' + e.message; }
  };
}

// ---------- Init ----------
document.getElementById('btn-send').onclick = sendCurrent;
document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
document.getElementById('btn-cancel').onclick = () => window.agentDesk.cancelAll().then(() => setWaiting(false));
document.getElementById('btn-konektor').onclick = openKonektorModal;
document.getElementById('btn-settings').onclick = () => openSettings();
document.getElementById('search').addEventListener('input', (e) => renderSidebar(e.target.value));
document.getElementById('btn-add-agent').onclick = () => openAgentModal();
document.getElementById('btn-edit-agent').onclick = () => openAgentModal(agentById(activeId));
document.getElementById('btn-del-agent').onclick = () => {
  const a = agentById(activeId);
  if (agents.length <= 1) { alert('Minimal satu agen.'); return; }
  if (!confirm('Hapus agen "' + a.name + '" beserta riwayat chatnya?')) return;
  agents = agents.filter(x => x.id !== a.id);
  delete chats[a.id];
  activeId = agents[0].id;
  persist(); renderSidebar(''); renderHeader(); renderMessages();
};

if (!agentById(activeId)) activeId = agents[0].id;
renderSidebar('');
renderHeader();
renderMessages();
// Konektor: heartbeat tiap 30 dtk, cek inbox tiap 6 dtk
if (kon.enabled) konektorHeartbeat();
setInterval(konektorHeartbeat, 30000);
setInterval(pollInbox, 6000);
window.agentDesk.hasKey().then(ok => { if (!ok) openSettings(true); });
