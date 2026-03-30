import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ImageAttachmentInput } from "@codex-remote/shared-types";

export type StoredImageAttachment = {
  name: string;
  path: string;
  url: string;
};

export class ImageUploadService {
  constructor(
    private readonly uploadsDir: string,
    private readonly publicPrefix: string,
    private readonly maxAttachments: number,
    private readonly maxAttachmentBytes: number
  ) {}

  async stage(attachments: ImageAttachmentInput[]) {
    if (attachments.length === 0) {
      return [] satisfies StoredImageAttachment[];
    }

    if (attachments.length > this.maxAttachments) {
      throw new Error(`You can attach up to ${this.maxAttachments} images per run.`);
    }

    const batchId = `upload_${randomUUID()}`;
    const batchDir = path.join(this.uploadsDir, batchId);
    await fs.mkdir(batchDir, { recursive: true });

    try {
      const stored: StoredImageAttachment[] = [];

      for (const [index, attachment] of attachments.entries()) {
        const file = this.decodeAttachment(attachment);
        const fileName = `${String(index + 1).padStart(2, "0")}-${file.name}`;
        const filePath = path.join(batchDir, fileName);
        const url = this.publicUrlForPath(filePath);
        if (!url) {
          throw new Error(`Unable to expose uploaded image ${file.name}.`);
        }

        await fs.writeFile(filePath, file.buffer);
        stored.push({
          name: file.name,
          path: filePath,
          url
        });
      }

      return stored;
    } catch (error) {
      await fs.rm(batchDir, { recursive: true, force: true });
      throw error;
    }
  }

  publicUrlForPath(filePath: string) {
    const relativePath = path.relative(this.uploadsDir, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Upload path is outside the public uploads directory: ${filePath}`);
    }

    const encodedPath = relativePath.split(path.sep).map(encodeURIComponent).join("/");
    return `${this.publicPrefix}${encodedPath}`;
  }

  displayNameForPath(filePath: string) {
    const baseName = path.basename(filePath);
    return baseName.replace(/^\d+-/, "") || "image";
  }

  private decodeAttachment(attachment: ImageAttachmentInput) {
    const name = this.sanitizeFileName(attachment.name, attachment.mimeType);
    if (!attachment.mimeType.startsWith("image/")) {
      throw new Error(`Unsupported attachment type for ${name}. Only images are allowed.`);
    }

    const matches = attachment.dataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!matches) {
      throw new Error(`Invalid image payload for ${name}.`);
    }

    const dataUrlMimeType = matches[1];
    const base64 = matches[2];
    if (dataUrlMimeType !== attachment.mimeType) {
      throw new Error(`Image type mismatch for ${name}.`);
    }
    if (!base64) {
      throw new Error(`Invalid image payload for ${name}.`);
    }

    const buffer = Buffer.from(base64.replace(/\s/g, ""), "base64");
    if (buffer.length === 0) {
      throw new Error(`Image ${name} is empty.`);
    }
    if (buffer.length > this.maxAttachmentBytes) {
      throw new Error(
        `Image ${name} is too large. Max ${(this.maxAttachmentBytes / (1024 * 1024)).toFixed(0)} MB per file.`
      );
    }

    return { name, buffer };
  }

  private sanitizeFileName(fileName: string, mimeType: string) {
    const trimmed = fileName.trim();
    const extension = path.extname(trimmed);
    const safeBaseName = path
      .basename(trimmed || "image", extension)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .replace(/\s+/g, " ")
      .trim();

    const safeExtension = this.extensionForMimeType(mimeType, extension);
    const normalizedBaseName = safeBaseName || "image";
    return `${normalizedBaseName}${safeExtension}`;
  }

  private extensionForMimeType(mimeType: string, extension: string) {
    const normalized = extension.toLowerCase();
    if (normalized) {
      return normalized;
    }

    switch (mimeType) {
      case "image/jpeg":
        return ".jpg";
      case "image/png":
        return ".png";
      case "image/webp":
        return ".webp";
      case "image/gif":
        return ".gif";
      case "image/svg+xml":
        return ".svg";
      case "image/heic":
        return ".heic";
      case "image/heif":
        return ".heif";
      default:
        return ".img";
    }
  }
}
