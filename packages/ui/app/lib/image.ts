// Mirrors packages/core/src/vision.ts assertImageDataUrlWithinLimit.
// The UI must not import @freemodelfinder/core, so this is a deliberate copy —
// keep in sync if the server-side limit ever changes.
export const MAX_IMAGE_DATA_BYTES = 10 * 1024 * 1024;

export function isImageDataUrlWithinLimit(url: string): boolean {
  if (!url.startsWith('data:')) return true;
  const comma = url.indexOf(',');
  if (comma < 0) return true;
  const meta = url.slice(5, comma);
  const isBase64 = meta.endsWith(';base64');
  const payload = url.slice(comma + 1);
  const approxBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
  return approxBytes <= MAX_IMAGE_DATA_BYTES;
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('failed to read file'));
      reader.readAsDataURL(file);
    } catch (e) {
      reject(e);
    }
  });
}
