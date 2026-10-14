/**
 * An image over the per-image limit is shrunk instead of refused (owner 2026-10-14: "파일 이미지 영상 다 … 다 되게").
 * Models take images up to 5 MB, and a Retina screenshot or a camera photo is often larger. The image is redrawn at
 * most 2560 px on its long side as JPEG, stepping quality down until it fits. If it still does not fit, or the
 * browser cannot decode it, the original comes back unchanged and the caller's limit check reports it.
 */
export async function fitImageUnder(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= maxBytes || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  try {
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const base = (file.name || "image").replace(/\.[^.]+$/, "");
    for (const quality of [0.86, 0.76, 0.64, 0.5]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= maxBytes) return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
    }
    return file;
  } finally {
    bitmap.close();
  }
}
