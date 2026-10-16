import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env } from "../env.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const TYPES = {
  "image/jpeg": { ext: "jpg", magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { ext: "webp", magic: (b: Buffer) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
} as const;
export type ImageMime = keyof typeof TYPES;
export const IMAGE_MIMES = Object.keys(TYPES) as ImageMime[];

/** Decode base64 + validasi tipe berdasarkan magic bytes (bukan hanya klaim mime dari klien). */
export function decodeImage(base64: string, mime: ImageMime): { ok: true; buf: Buffer } | { ok: false; reason: "format" | "size" } {
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean)) return { ok: false, reason: "format" };
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) return { ok: false, reason: "format" };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: "size" };
  if (!TYPES[mime].magic(buf)) return { ok: false, reason: "format" };
  return { ok: true, buf };
}

export const mimeFromPath = (p: string): ImageMime =>
  p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";

const root = () => resolve(env.RECEIPTS_DIR);

/** Simpan foto di RECEIPTS_DIR/<householdId>/<scanId>.<ext>. Mengembalikan path relatif terhadap root. */
export async function saveImage(householdId: string, scanId: string, mime: ImageMime, buf: Buffer) {
  // ID dibuat server (UUID), tapi tetap disaring agar path tidak bisa keluar dari root.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, "");
  const rel = join(safe(householdId), `${safe(scanId)}.${TYPES[mime].ext}`);
  await mkdir(join(root(), safe(householdId)), { recursive: true });
  await writeFile(join(root(), rel), buf, { mode: 0o600 });
  return rel;
}

export const readImage = (rel: string) => readFile(join(root(), rel));
export const deleteImage = (rel: string) => rm(join(root(), rel), { force: true });
