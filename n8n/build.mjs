// Generator workflow n8n (2.32.x). Menulis receipt-ocr.workflow.json & receipt-archive.workflow.json.
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CRED = {
  webhook: { id: "WAFo088uY4bwp4j5", name: "Catatan Rumah – Webhook Secret" },
  gemini: { id: "zEkQZNj61Diwfnkm", name: "Gemini – Catatan Rumah" },
  drive: { id: "h5GGqr9s5GXgEYpf", name: "Google Drive – Catatan Rumah" },
};
const FOLDER_ID = process.env.FOLDER_ID ?? "";
const SETTINGS = {
  executionOrder: "v1",
  // Payload berisi foto (base64): jangan simpan eksekusi sukses agar DB n8n tidak membengkak.
  saveDataSuccessExecution: "none",
  saveDataErrorExecution: "all",
  saveManualExecutions: true,
  saveExecutionProgress: false,
};

// ---------------- Receipt OCR API ----------------
const prepareGemini = String.raw`// Validasi payload dari app Catatan Rumah lalu susun request Gemini (output JSON terstruktur).
const body = $input.first().json.body ?? {};
const allowed = ['image/jpeg', 'image/png', 'image/webp'];
if (typeof body.imageBase64 !== 'string' || body.imageBase64.length < 100 || !allowed.includes(body.mimeType)) {
  throw new Error('Payload OCR tidak valid');
}
const categories = (Array.isArray(body.categories) ? body.categories : [])
  .filter((c) => typeof c === 'string' && c.length <= 60)
  .slice(0, 50);
const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? '') ? body.today : new Date().toISOString().slice(0, 10);

const prompt = [
  'Kamu membaca foto nota/struk belanja dari Indonesia. Ekstrak datanya ke JSON sesuai schema.',
  'Aturan:',
  '- merchant: nama toko lengkap = merek/jaringan + cabang jika tertulis (contoh: "Indomaret Plus Pamekasan", "Alfamart Rungkut"), huruf kapital wajar, tanpa alamat jalan. null jika tidak terbaca.',
  '- date: tanggal transaksi format YYYY-MM-DD. Nota Indonesia biasanya DD/MM/YY, DD-MM-YYYY, atau DD.MM.YYYY (hari dulu, lalu bulan). Tahun 2 digit = 20xx.',
  '  Jika tanggal tidak terlihat, isi null. Jangan menebak. Sebagai konteks, hari ini ' + today + '.',
  '- items: setiap baris barang yang dibeli. name = nama barang dirapikan (huruf kapital wajar, singkatan umum boleh diperjelas).',
  '  qty = jumlah (default 1). unit_price = harga satuan. total = harga baris (qty x harga, setelah diskon item jika ada).',
  '  Abaikan baris yang bukan barang: subtotal, PPN, tunai, kembalian, poin, member, voucher, kartu.',
  '- subtotal, discount (total diskon, angka positif), tax: angka atau null.',
  '- total: jumlah yang harus dibayar (TOTAL / GRAND TOTAL), bukan uang tunai atau kembalian.',
  '- category: pilih SATU dari daftar ini yang paling cocok untuk keseluruhan nota, tulis persis sama:',
  '  ' + (categories.length ? JSON.stringify(categories) : '[]') + '. Jika tidak ada yang cocok, null.',
  '- Semua nominal dalam rupiah sebagai angka bulat tanpa pemisah ribuan (25.500 menjadi 25500).',
  '- Jika gambar bukan nota atau tidak bisa dibaca, isi error dengan alasan singkat dan field lain null.',
].join('\n');

const num = { type: 'NUMBER', nullable: true };
const geminiPayload = {
  contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: body.mimeType, data: body.imageBase64 } }] }],
  generationConfig: {
    temperature: 0,
    // Thinking dimatikan: untuk nota, thinking memakan ~95% token & waktu tanpa menambah akurasi berarti.
    thinkingConfig: { thinkingBudget: 0 },
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        error: { type: 'STRING', nullable: true },
        merchant: { type: 'STRING', nullable: true },
        date: { type: 'STRING', nullable: true },
        category: { type: 'STRING', nullable: true },
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { name: { type: 'STRING' }, qty: num, unit_price: num, total: num },
            required: ['name'],
          },
        },
        subtotal: num,
        discount: num,
        tax: num,
        total: num,
      },
      required: ['items'],
    },
  },
};
return [{ json: { scanId: body.scanId ?? null, geminiPayload } }];`;

const parseGemini = String.raw`// Ambil teks JSON dari balasan Gemini. Jika gagal, kembalikan { error } agar app menampilkan "nota tidak terbaca".
const res = $input.first().json;
const cand = res.candidates?.[0];
const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = { error: 'Balasan AI tidak bisa dibaca' + (cand?.finishReason ? ' (' + cand.finishReason + ')' : '') };
}
if (!data || typeof data !== 'object' || Array.isArray(data)) data = { error: 'Format balasan AI tidak sesuai' };
return [{ json: data }];`;

const ocr = {
  name: "Catatan Rumah – Receipt OCR API",
  nodes: [
    {
      id: randomUUID(), name: "Webhook OCR", type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [0, 0],
      webhookId: randomUUID(),
      parameters: { httpMethod: "POST", path: "catatan-rumah/receipt-ocr", authentication: "headerAuth", responseMode: "responseNode", options: {} },
      credentials: { httpHeaderAuth: CRED.webhook },
    },
    { id: randomUUID(), name: "Siapkan request Gemini", type: "n8n-nodes-base.code", typeVersion: 2, position: [240, 0], parameters: { jsCode: prepareGemini } },
    {
      id: randomUUID(), name: "Gemini OCR", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [480, 0],
      onError: "continueErrorOutput", retryOnFail: true, maxTries: 2, waitBetweenTries: 2000,
      parameters: {
        method: "POST",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
        sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.geminiPayload) }}",
        options: { timeout: 80000 },
      },
      credentials: { httpHeaderAuth: CRED.gemini },
    },
    { id: randomUUID(), name: "Parse hasil", type: "n8n-nodes-base.code", typeVersion: 2, position: [720, -100], parameters: { jsCode: parseGemini } },
    {
      id: randomUUID(), name: "Balas hasil OCR", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [960, -100],
      parameters: { respondWith: "json", responseBody: "={{ JSON.stringify($json) }}", options: {} },
    },
    {
      id: randomUUID(), name: "Balas error Gemini", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [720, 120],
      parameters: { respondWith: "json", responseBody: "={{ JSON.stringify({ upstreamError: true }) }}", options: { responseCode: 502 } },
    },
  ],
  connections: {
    "Webhook OCR": { main: [[{ node: "Siapkan request Gemini", type: "main", index: 0 }]] },
    "Siapkan request Gemini": { main: [[{ node: "Gemini OCR", type: "main", index: 0 }]] },
    "Gemini OCR": { main: [[{ node: "Parse hasil", type: "main", index: 0 }], [{ node: "Balas error Gemini", type: "main", index: 0 }]] },
    "Parse hasil": { main: [[{ node: "Balas hasil OCR", type: "main", index: 0 }]] },
  },
  settings: SETTINGS,
};

// ---------------- Receipt Archive ----------------
const prepareFile = String.raw`// Ubah base64 dari app menjadi file biner untuk diupload ke Google Drive.
const b = $input.first().json.body ?? {};
const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[b.mimeType];
if (typeof b.imageBase64 !== 'string' || b.imageBase64.length < 100 || !ext) {
  throw new Error('Payload arsip tidak valid');
}
const fileName = String(b.fileName || 'nota_' + Date.now() + '.' + ext).replace(/[^\w.\- ]/g, '_').slice(0, 120);
return [{
  json: { fileName, transactionId: b.transactionId ?? null },
  binary: { data: { data: b.imageBase64, mimeType: b.mimeType, fileName, fileExtension: ext } },
}];`;

const archive = {
  name: "Catatan Rumah – Receipt Archive (Drive)",
  nodes: [
    {
      id: randomUUID(), name: "Webhook Arsip", type: "n8n-nodes-base.webhook", typeVersion: 2.1, position: [0, 0],
      webhookId: randomUUID(),
      parameters: { httpMethod: "POST", path: "catatan-rumah/receipt-archive", authentication: "headerAuth", responseMode: "responseNode", options: {} },
      credentials: { httpHeaderAuth: CRED.webhook },
    },
    { id: randomUUID(), name: "Siapkan file", type: "n8n-nodes-base.code", typeVersion: 2, position: [240, 0], parameters: { jsCode: prepareFile } },
    {
      id: randomUUID(), name: "Upload ke Nota Belanja", type: "n8n-nodes-base.googleDrive", typeVersion: 3, position: [480, 0],
      onError: "continueErrorOutput", retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
      parameters: {
        name: "={{ $json.fileName }}",
        driveId: { __rl: true, mode: "list", value: "My Drive", cachedResultName: "My Drive" },
        folderId: { __rl: true, mode: "id", value: FOLDER_ID },
        options: {},
      },
      credentials: { googleDriveOAuth2Api: CRED.drive },
    },
    {
      id: randomUUID(), name: "Balas link Drive", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [720, -100],
      parameters: {
        respondWith: "json",
        responseBody: "={{ JSON.stringify({ fileId: $json.id, webViewLink: $json.webViewLink || ('https://drive.google.com/file/d/' + $json.id + '/view') }) }}",
        options: {},
      },
    },
    {
      id: randomUUID(), name: "Balas error Drive", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [720, 120],
      parameters: { respondWith: "json", responseBody: "={{ JSON.stringify({ upstreamError: true }) }}", options: { responseCode: 502 } },
    },
  ],
  connections: {
    "Webhook Arsip": { main: [[{ node: "Siapkan file", type: "main", index: 0 }]] },
    "Siapkan file": { main: [[{ node: "Upload ke Nota Belanja", type: "main", index: 0 }]] },
    "Upload ke Nota Belanja": { main: [[{ node: "Balas link Drive", type: "main", index: 0 }], [{ node: "Balas error Drive", type: "main", index: 0 }]] },
  },
  settings: SETTINGS,
};

writeFileSync("receipt-ocr.workflow.json", JSON.stringify(ocr, null, 2) + "\n");
writeFileSync("receipt-archive.workflow.json", JSON.stringify(archive, null, 2) + "\n");
console.log("ok", FOLDER_ID ? "folder set" : "folder kosong");
