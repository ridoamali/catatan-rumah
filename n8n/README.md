# Workflow n8n untuk Catatan Rumah

Dibuat untuk n8n 2.32.7. Kedua workflow memakai credential yang dibuat manual di n8n
(nilai rahasia tidak pernah ada di file ini; yang tercantum hanya ID & nama credential).

| Workflow | ID n8n | Webhook (production) |
|---|---|---|
| Catatan Rumah – Receipt OCR API | 6EHw5aeEIILHU62L | `POST /webhook/catatan-rumah/receipt-ocr` |
| Catatan Rumah – Receipt Archive (Drive) | G05htkxu0rbbIU5l | `POST /webhook/catatan-rumah/receipt-archive` |
| Catatan Rumah – Spending Insight | bZrGBmvSdUmJjKvF | `POST /webhook/catatan-rumah/spending-insight` |

Spending Insight (Langkah 6b): menerima `{ input }` (ringkasan angka dari app, tanpa catatan/nama/email), Gemini
`gemini-2.5-flash` dengan `responseSchema` & thinking off, membalas `{ summary, highlights, anomalies, tips }`.
Generator: `cd n8n && node build-insight.mjs`. Contoh payload uji: `sample-insight-input.json` (data rekaan).

- Auth: Header Auth `X-Webhook-Secret` (credential "Catatan Rumah – Webhook Secret"), nilainya sama dengan `N8N_WEBHOOK_SECRET` di `.env` app.
- Gemini: `gemini-2.5-flash`, API key lewat header `x-goog-api-key` (credential "Gemini – Catatan Rumah").
- Drive: upload ke folder **Nota Belanja** (dipilih dari daftar di node, tidak tercantum di JSON).
- Eksekusi sukses tidak disimpan (`saveDataSuccessExecution: none`) karena payload berisi foto base64; eksekusi error tetap disimpan untuk debugging.

`build.mjs` adalah generator kedua file JSON. Jalankan ulang (`node n8n/build.mjs`) bila struktur workflow berubah,
lalu terapkan ke n8n. Setelah import ulang, folder Drive perlu dipilih lagi di node "Upload ke Nota Belanja".
