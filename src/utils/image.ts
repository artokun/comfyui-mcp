export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function base64ToDataUrl(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}

export function arrayBufferToDataUrl(
  buffer: ArrayBuffer,
  mime: string,
): string {
  return base64ToDataUrl(arrayBufferToBase64(buffer), mime);
}
