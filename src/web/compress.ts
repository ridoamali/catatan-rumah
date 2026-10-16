// Kompres foto nota di browser sebelum upload: sisi terpanjang ≤ 1600px, JPEG kualitas 0.75.
// Orientasi EXIF dari kamera HP diterapkan agar nota tidak miring/terbalik.

export const MAX_SIDE = 1600;
export const QUALITY = 0.75;

export type Compressed = {
  blob: Blob;
  base64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  originalBytes: number;
};

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fallback ke <img> di bawah */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function compressImage(file: File): Promise<Compressed> {
  if (!file.type.startsWith("image/")) throw new Error("File yang dipilih bukan gambar.");
  const src = await decode(file);
  const w0 = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h0 = "naturalHeight" in src ? src.naturalHeight : src.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Browser tidak mendukung pemrosesan gambar.");
  ctx.fillStyle = "#fff"; // latar putih untuk PNG transparan
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(src, 0, 0, width, height);
  if ("close" in src) src.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal mengompres gambar."))), "image/jpeg", QUALITY),
  );
  return { blob, base64: await toBase64(blob), mimeType: "image/jpeg", width, height, originalBytes: file.size };
}

export const formatBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.round(n / 1024)} KB`;
