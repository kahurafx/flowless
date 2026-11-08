/** The file service (K-08): photos, evidence and documents attached to a record. */
export const FILE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"] as const;
export type FileMimeType = (typeof FILE_MIME_TYPES)[number];

export const FILE_STATUSES = ["pending", "uploaded"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** Per record, unless its subject sets its own. */
export const DEFAULT_FILE_LIMITS = { photos: 10, documents: 5, maxBytes: 25 * 1024 * 1024 } as const;
export type FileLimits = { photos: number; documents: number; maxBytes: number };

export const isPhoto = (mimeType: string) => mimeType.startsWith("image/");
