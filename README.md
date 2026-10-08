# AgentDesk 🖥️

Aplikasi desktop multi-agent — tiap "agen" adalah chat terpisah ke Muse (via 9Router + muse-bridge),
dan agen-agen **bisa saling berkirim pesan** — bahkan antar-perangkat.

## Cara pakai (Windows)

1. Extract `AgentDesk-win32-x64.zip` (atau `.tar.gz` untuk Linux, jalankan file `agentdesk`)
2. Jalankan `AgentDesk.exe`
3. Buka **⚙ Pengaturan**, isi:
   - Base URL: `http://127.0.0.1:20128` (bila 9Router jalan di mesin yang sama;
     pakai `https://url.pages.dev` bila 9Router di mesin lain via tunnel)
   - API key: API key 9Router kamu (hanya tersimpan di PC ini)
   - Model: `muse-spark`
4. Klik **🔌 Tes koneksi** — harus ✅
5. Chat dengan agen mana pun di daftar kiri.

## Agen saling terhubung — cara kerjanya

- **Tombol ➡️ teruskan** di tiap pesan: kirim pesan itu ke chat agen lain.
  Pesan masuk sebagai `📨 [Dari NamaAgen]` dan agen tujuan **langsung menjawab otomatis**.
- **Delegasi oleh Chief**: Chief bisa mendelegasikan dengan menulis tag persis:
  `[[KIRIM:dev]] tolong buatkan fungsi login`
  Aplikasi otomatis meneruskan ke `dev`, dan **balasan dev otomatis kembali ke chat Chief**.
- Pengaman: rantai delegasi maksimal 4 lompatan, deteksi loop otomatis.

## 🔗 Konektor antar-perangkat

Dua AgentDesk di perangkat berbeda (misal PC + laptop) bisa saling terhubung:

1. **Deploy server sekali** (di PC yang sudah `wrangler login`):
   extract `konektor-server.zip` ke `tunnel/pages-tunnel/`, lalu `bash deploy-konektor.sh`
   (migrasi D1 + deploy Pages Functions; opsional: set `KONEKTOR_KEY` sebagai secret)
2. Di tiap perangkat: buka panel **🔗 Konektor** → centang **Aktifkan Konektor** →
   isi nama perangkat (misal `PC`, `Laptop`) → Simpan.
3. Perangkat lain yang online muncul di daftar. Teruskan pesan lewat tombol ➡️
   (bagian "🌐 Perangkat lain"), atau delegasi lintas perangkat:
   `[[KIRIM:dev@Laptop]] tolong review kode ini`
   Balasan otomatis kembali ke chat pengirim.

Cara kerja: relay murni di edge (Pages Functions + D1 `tunnel-router`), tidak lewat
tunnel client/VM. Heartbeat tiap 30 detik, inbox di-poll tiap 6 detik.
Pesan `task` memicu satu auto-balasan; balasan (`reply`) hanya ditampilkan — anti-loop.

## Kenapa ada antrean?

muse-bridge di server hanya punya **1 worker** (~13 detik per request).
Aplikasi mengantrekan semua request satu per satu — kalau tidak, 9Router melempar
`504 tunnel timeout`. Indikator `⏳ Antrean bridge: N pesan` muncul saat ada yang menunggu.

## Agen bawaan

| Agen | Peran |
|------|-------|
| 🎯 Chief | Koordinator — delegasikan tugas ke agen lain |
| 🔬 research | Riset & rangkuman |
| 💻 dev | Ngoding & debugging |
| 🧪 qa | Testing & review |
| 🛠️ ops | Deploy, server, operasional |

Tambah/edit/hapus agen lewat tombol **+ Agen baru** / **✏️ Edit**.
System prompt tiap agen bisa diubah bebas.

## Build dari source (opsional)

Butuh Node.js 20+ di PC:

```
npm install
npm start            # jalan mode dev
npm run dist         # build Windows portable (butuh wine di Linux)
```

Struktur: `main.js` (antrean request + API key, aman di main process),
`preload.js` (jembatan IPC), `renderer/` (UI).
API key **tidak pernah** disimpan di file project — hanya di folder userData aplikasi.
