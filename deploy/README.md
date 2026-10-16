# Deploy Catatan Rumah ke STB CasaOS

## Status paket

File Docker dan Compose tersedia untuk Linux ARM64. Workflow GitHub Actions tersedia di
`.github/workflows/container.yml`; image siap dipakai hanya setelah run terkait berhasil.
Belum ada deployment di STB atau perubahan domain/Tunnel dari paket ini.

Target runtime adalah Node 24 di Debian Bookworm, dengan dependency produksi saja.
Tahap build menyediakan Python/make/g++ untuk mengompilasi dependency SQLite bila diperlukan;
alat tersebut tidak disalin ke image runtime.
Backend dikompilasi TypeScript, frontend disajikan oleh Fastify dalam proses yang sama.
Image berjalan sebagai user `node` (UID/GID 1000), dan hanya `/app/data` serta `/tmp` yang dapat ditulis.
SQLite dan foto nota berada di bind mount `/DATA/AppData/catatan-rumah/data`.

## Pemeriksaan STB sebelum deployment

Jalankan di STB dan catat hasilnya:

```sh
uname -m
docker compose version
df -h / /DATA
free -h
```

`uname -m` harus `aarch64` untuk Compose yang disediakan. Docker Engine dan plugin Compose
adalah komponen terpisah; versi Engine saja belum membuktikan Compose terpasang.
Tentukan juga apakah n8n dan cloudflared berjalan di STB ini, di container, atau di host lain.

## Build image (tahap terpisah sebelum rollout)

GitHub Actions membangun image pada runner ARM64 native (`ubuntu-24.04-arm`) setiap push ke
`main`, saat pull request, atau lewat Run workflow. Tahapannya: typecheck dan tes API,
uji server produksi, validasi Compose, build image, lalu uji container dengan filesystem
read-only, user non-root, cookie Secure, dan data yang bertahan setelah restart.
Hanya push/manual di `main` yang menerbitkan image setelah semua pemeriksaan lulus.

Image yang SAMA dengan yang diuji dikirim ke `ghcr.io/ridoamali/catatan-rumah:main`
dan `ghcr.io/ridoamali/catatan-rumah:sha-<commit-penuh>`. Workflow memakai `GITHUB_TOKEN`
dengan izin `packages: write`; tidak membutuhkan API key n8n atau secret app.
Jangan menjalankan `compose pull` sebelum run berhasil dan image tersedia.
Gunakan tag commit atau digest yang sudah diuji untuk deployment agar versi rollback jelas.

Periksa hasil di tab Actions → Build ARM64 image. Jika run gagal, buka step merah dan
perbaiki penyebabnya sebelum rollout. Jika tidak ada run, cek bahwa Actions diizinkan di repo.
Untuk private repo, eksekusi memakai kuota Actions akun; izin package GHCR tetap mengikuti
pengaturan GitHub. Paket tidak diubah menjadi publik oleh workflow ini.

Untuk menguji manual pada mesin dengan Docker Buildx dan dukungan ARM64:

```sh
docker buildx build --platform linux/arm64 --load -t catatan-rumah:arm64-test .
```

Build context hanya menyertakan source, konfigurasi build, package lock, dan migrasi.
`.env`, database, foto, folder `.git`, dan workflow n8n tidak dikirim ke builder.
Uji container dengan volume sementara dahulu; jangan memakai data asli untuk uji image.

## Konfigurasi di STB (setelah image lulus uji)

Gunakan checkout repo di STB. Semua perintah Compose di bawah dijalankan dari root repo.

```sh
install -d -m 700 -o 1000 -g 1000 /DATA/AppData/catatan-rumah/data
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Isi `deploy/.env`: ganti `ALLOWED_ORIGINS` dengan origin HTTPS final tanpa slash akhir,
dan isi `N8N_WEBHOOK_SECRET` yang sama dengan credential n8n. Jangan menyalin seluruh
`.env` development karena path dan mode server berbeda. Jangan kirim secret ke chat.
`NODE_ENV`, path DB/foto, dan `OCR_MOCK=off` ditetapkan Compose.

Validasi tanpa mencetak nilai environment:

```sh
docker compose config --quiet
```

**Data awal:** volume kosong menampilkan pendaftaran household baru. Data di Mac tidak otomatis
dipindahkan. Jika ingin mempertahankan akun dan transaksi Mac, stop app Mac terlebih dahulu,
salin seluruh isi `data/` (DB beserta WAL/SHM jika ada dan folder receipts) ke volume STB sebelum
container pertama kali dinyalakan, lalu atur pemiliknya menjadi UID/GID 1000. Jangan menggabungkan
dua database yang sudah dipakai. Simpan salinan Mac sebagai cadangan sebelum pemindahan.

## HTTPS dan Cloudflare (topologi perlu dipastikan dahulu)

Port app di STB hanya dipublikasikan ke `127.0.0.1:3080`. Dengan cloudflared yang berjalan
langsung di host STB, origin Tunnel dapat diarahkan ke `http://127.0.0.1:3080`.
Jika cloudflared ada dalam container, `localhost` merujuk ke container cloudflared sendiri;
konfigurasi jaringan harus disesuaikan sebelum Tunnel dipakai. Jangan membuka port ini ke internet.

Pasang kebijakan Cloudflare Access untuk email keluarga sebelum membuka hostname publik.
Siapkan origin HTTPS tersebut di `ALLOWED_ORIGINS`. Cookie produksi memakai `Secure`,
sehingga pengujian login harus melalui HTTPS. Endpoint health lokal bisa diuji melalui HTTP.

Saat ini app belum mempercayai header proxy untuk IP klien. Di belakang Tunnel, rate limit
dapat memakai IP proxy bersama. Konfigurasi trusted proxy harus dibatasi sesuai topologi yang
terverifikasi; jangan memakai `trustProxy: true` secara umum.

## Menjalankan (setelah konfigurasi dan akses siap)

Set `CATATAN_IMAGE` ke image/tag atau digest yang sudah tersedia dan diuji. Contoh
`ghcr.io/ridoamali/catatan-rumah:sha-<commit>` hanya pola nama, bukan tag yang sudah diterbitkan.
Untuk GHCR private, login registry di STB lebih dahulu menggunakan akses baca package.

```sh
docker compose pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3080/api/health
```

Compose memakai `${CATATAN_IMAGE}` dari environment shell, dengan default tag `main`.
Untuk image uji lokal, jalankan `CATATAN_IMAGE=catatan-rumah:arm64-test docker compose up -d --pull never`.
Status harus healthy dan health API membalas `{"status":"ok","db":"ok"}`.
Uji login, transaksi, scan/arsip Drive, dan Analisa AI melalui domain HTTPS.
Belum ada manifest katalog CasaOS khusus; gunakan Docker Compose di host CasaOS sebagai dasar.

## Backup dan rollback

Backup sederhana yang konsisten: hentikan app, arsipkan **seluruh** volume data, lalu hidupkan
kembali. Simpan arsip di luar folder data dan salin ke media/host lain. Jangan menyalin hanya
file `.db` saat app aktif karena SQLite menggunakan WAL. Saat membuat cadangan, lindungi juga
`deploy/.env` secara terpisah karena berisi secret.

Contoh di STB (root), dari root repo:

```sh
install -d -m 700 /DATA/Backups/catatan-rumah
docker compose stop app
```

Pastikan container sudah berhenti, kemudian:

```sh
umask 077
tar -C /DATA/AppData/catatan-rumah -czf "/DATA/Backups/catatan-rumah/data-$(date +%Y%m%d-%H%M%S).tar.gz" data
docker compose start app
```

Jika arsip gagal, hidupkan kembali app dan ulangi backup setelah penyebabnya diperbaiki.
Uji restore ke folder terpisah dan image dengan versi yang sama sebelum mengandalkan cadangan.

Rollback: hentikan app, simpan data terbaru, kembalikan image sebelumnya. Jika migrasi versi
baru tidak kompatibel, pulihkan volume dari backup sebelum upgrade ke folder data yang kosong;
jangan mengekstrak backup menimpa DB/WAL yang masih aktif. Atur kembali kepemilikan UID/GID 1000,
lalu jalankan image sebelumnya. Transaksi setelah waktu backup tidak ada dalam hasil restore.

Referensi: [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/),
[Docker Compose services](https://docs.docker.com/reference/compose-file/services/).
Referensi CI: [publikasi image GitHub](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[runner ARM64](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
