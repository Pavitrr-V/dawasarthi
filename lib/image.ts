import { IMAGE_MAX_SIZE, IMAGE_QUALITY } from "@/lib/constants";

type Bitmap = ImageBitmap | HTMLImageElement;

async function loadBitmap(file: File): Promise<Bitmap> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> decoder below.
    }
  }

  return await new Promise<Bitmap>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("We could not read that image."));
    };
    image.src = url;
  });
}

function bitmapSize(bitmap: Bitmap): { width: number; height: number } {
  if (bitmap instanceof HTMLImageElement) {
    return {
      width: bitmap.naturalWidth || bitmap.width,
      height: bitmap.naturalHeight || bitmap.height,
    };
  }
  return { width: bitmap.width, height: bitmap.height };
}

/**
 * Downscale an image to fit within maxSize on its longest edge and encode it
 * as JPEG. Runs entirely in the browser (canvas), so it needs a DOM.
 */
export async function compressImage(
  file: File,
  options: { maxSize?: number; quality?: number } = {}
): Promise<Blob> {
  const maxSize = options.maxSize ?? IMAGE_MAX_SIZE;
  const quality = options.quality ?? IMAGE_QUALITY;

  const bitmap = await loadBitmap(file);
  const { width, height } = bitmapSize(bitmap);
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot process images.");

  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  if (bitmap instanceof ImageBitmap) bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
  if (!blob) throw new Error("We could not prepare that image.");

  return blob;
}
