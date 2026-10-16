# Catatan Rumah

Web app pencatatan rumah tangga: transaksi, scan nota (via n8n), laporan grafik,
analisa AI (via n8n), dan pengingat (in-app, web push, Telegram, WhatsApp).

Stack: Node + Fastify (API) · React + Vite (UI) · SQLite (better-sqlite3 + Drizzle).

## Menjalankan lokal (macOS)

```bash
node -v                # harus >= 22.12 (Docker memakai Node 24)
cp .env.example .env
npm install
npm run dev            # API :3000 + UI :5173 (migrasi DB jalan otomatis)
npm test               # tes API (positif & negatif)
```

Verifikasi:

```bash
curl -s http://127.0.0.1:3000/api/health   # {"status":"ok","db":"ok"}
open http://localhost:5173                  # status "API: terhubung · DB ok"
```

Mode produksi lokal: `npm run build && npm start` → http://127.0.0.1:3000

Deployment STB ARM64 + CasaOS/Docker: lihat [panduan deployment](deploy/README.md).
`npm run build` membangun frontend ke `dist/` dan backend ke `dist-server/`.
Server produksi berjalan langsung dengan Node, tanpa `tsx`.

## Struktur

```
src/server/   Fastify API, env, database (Drizzle)
src/web/      React UI
data/         file SQLite (tidak di-commit)
drizzle/      migrasi SQL (di-commit; jalan otomatis saat server start)
```

## Progres

- [x] 1. Scaffold
- [x] 2. Auth multi-user + household
- [x] 3. Transaksi, kategori, anggaran
- [x] 4. Scan nota (webhook n8n)
- [x] 5. Laporan grafik
- [x] 6. Analisa AI (webhook n8n) — app dan workflow terhubung; uji app dengan AI sungguhan lulus 16 Oktober 2026
- [ ] 7. Pengingat

## Auth (Langkah 2)

- Akun pertama dibuat lewat layar "Buat rumah tangga" dan otomatis menjadi **owner**.
  Setelah itu pendaftaran bebas tertutup. Anggota lain hanya bisa masuk lewat **kode undangan** (Anggota → Buat kode undangan).
- Kode undangan sekali pakai dan berlaku 7 hari. Kode disimpan sebagai hash.
- Password di-hash dengan scrypt. Sesi disimpan sebagai cookie httpOnly + SameSite=Lax (30 hari, diperpanjang otomatis).
- Login, setup, dan join dibatasi 10 percobaan / 15 menit per IP.
- Reset total DB lokal (dev saja): stop server, lalu `rm data/catatan-rumah.db*`.

## Transaksi & anggaran (Langkah 3)

- Nominal disimpan sebagai bilangan bulat rupiah. Tanggal transaksi berformat `YYYY-MM-DD` (zona Asia/Jakarta).
- Kategori default (11 pengeluaran + 3 pemasukan) dibuat otomatis untuk setiap rumah tangga. Kategori bisa ditambah atau diarsipkan.
- Hapus transaksi = *soft delete* (`deleted_at`). Data tidak hilang dari DB, tapi tidak lagi muncul di daftar dan ringkasan.
- Kolom `source` (`web` | `scan` | `telegram` | `import`) dan `external_ref` (unik per rumah tangga + source) disiapkan untuk input dari bot Telegram dan impor data lama Google Sheets tanpa data dobel.
- Anggaran: nominal bulanan tetap per kategori pengeluaran, hanya owner yang dapat mengubahnya.
  Status di Ringkasan: Aman (<80%), Hampir habis (80–100%), Melebihi anggaran (>100%).

## Scan nota (Langkah 4a)

Alur: foto (kamera/galeri) → dikompres di browser (maks 1600 px, JPEG 75%) → server → webhook OCR n8n
→ layar review (toko, tanggal, kategori saran AI, item, total) → simpan sebagai transaksi `source=scan`
beserta rincian item (`transaction_items`) → foto diarsip ke Google Drive lewat webhook arsip n8n.

- Browser tidak pernah memanggil n8n langsung. Server yang memanggil, dengan header `X-Webhook-Secret`.
- Batal di layar review → foto dihapus, tidak ada yang masuk Drive. Sesi yang ditinggal > 24 jam dibersihkan otomatis.
- Simpan tidak menunggu Drive: transaksi langsung tersimpan (`receipt_status=pending`), arsip berjalan di background.
- Arsip Drive gagal → status `failed`, foto tetap di server (`data/receipts/`). Dicoba ulang otomatis saat server start & tiap 6 jam,
  atau manual dari detail transaksi. Arsip `pending` yang macet (server mati di tengah arsip) dilanjutkan tiap 15 menit.
- Indikator progres scan: persen kompres+upload nyata; persen menunggu OCR = estimasi dari rata-rata durasi scan sebelumnya
  (disimpan di browser), berhenti di 95% sampai hasil datang.
- `N8N_RECEIPT_ARCHIVE_URL` kosong → foto disimpan di server (status `local`).
- Tanpa `N8N_RECEIPT_OCR_URL` di development → **mode contoh** (data OCR palsu, ditandai jelas di UI).
- Batas: foto maks 5 MB setelah kompresi, 30 scan per jam per IP.

## Laporan (Langkah 5)

`GET /api/reports?from=YYYY-MM&to=YYYY-MM` (default 6 bulan terakhir, maks 24 bulan):
tren bulanan keluar/masuk (bulan kosong tetap muncul), per kategori, per anggota (pencatat), toko teratas
(nama dinormalisasi huruf kecil/spasi), dan perubahan harga barang dari rincian nota (dibeli ≥ 2 kali; harga satuan
dihitung dari total/qty bila kosong). Grafik dibuat dengan SVG sendiri (tanpa library): tooltip lewat hover & fokus keyboard,
tampilan Tabel sebagai alternatif, warna seri divalidasi untuk buta warna di mode terang & gelap.
Di mobile, tab bar: Beranda · Transaksi · + · Scan · Laporan. Anggaran dibuka dari Beranda (tombol Atur/Atur anggaran).

## Analisa AI (Langkah 6a)

`POST /api/insights {month}` menyusun ringkasan bulan itu (semua angka dihitung app: total, per kategori vs rata-rata
3 bulan sebelumnya & anggaran, 5 toko teratas, 10 transaksi terbesar, perubahan harga barang), mengirimnya ke webhook
`N8N_INSIGHT_URL`, memvalidasi balasan (ringkasan, sorotan, transaksi janggal, saran hemat), lalu menyimpannya di tabel
`insights`. `GET /api/insights?month=` mengembalikan analisa tersimpan tanpa memanggil AI lagi. Dibatasi 10 analisa/jam.

**Tidak dikirim ke AI:** catatan transaksi, nama & email anggota, nama rumah tangga, ID internal (dijaga oleh tes).
Ringkasan yang dikirim disimpan di kolom `input_json` untuk audit.
