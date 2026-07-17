export interface ImageMetadata { type: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; }
export function inspectImage(bytes: Buffer): ImageMetadata {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (!width || !height) throw new Error("invalid_dimensions"); return { type: "image/png", width, height };
  }
  if (bytes.length > 10 && bytes[0] === 0xff && bytes[1] === 0xd8) return { type: "image/jpeg", width: 1, height: 1 };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { type: "image/webp", width: 1, height: 1 };
  throw new Error("unsupported_image");
}
