import { DEFAULT_FILE_LIMITS, FILE_MIME_TYPES } from "@flowless/shared-types";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { uid } from "./ids";
import type { UploadSpec } from "./sync/build";
import type { LocalFile } from "./types";

/**
 * Photos picked on this phone (K-08, W-02). Field names follow the API's `files.announce` input, so
 * uploading is `announce`, a PUT of the bytes to the presigned URL it returns, then `confirm`.
 * The subject (a job, an asset) is given when the file is attached to something.
 */
export const MAX_PHOTOS = DEFAULT_FILE_LIMITS.photos;
export const MAX_FILE_BYTES = DEFAULT_FILE_LIMITS.maxBytes;
const ALLOWED = new Set<string>(FILE_MIME_TYPES);
const isAllowed = (type: string): type is LocalFile["mimeType"] => ALLOWED.has(type);

export type PickResult =
  | { ok: true; items: LocalFile[]; note?: string }
  | { ok: false; reason: "cancelled" | "denied" | "failed"; canAskAgain?: boolean };

const FOLDER = "attachments";

/** Pickers hand back cache files the OS may delete. Copy into the documents folder so nothing is lost before it uploads. */
function keepLocally(sourceUri: string, name: string): string {
  const folder = new Directory(Paths.document, FOLDER);
  if (!folder.exists) folder.create({ intermediates: true });
  const target = new File(folder, `${uid()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  new File(sourceUri).copy(target);
  return target.uri;
}

/**
 * Where a kept file is, relative to the documents folder. That is what gets saved: the folder's
 * absolute path can change when the app is updated (on iOS it does).
 */
export const relativePath = (uri: string) => `${FOLDER}/${decodeURIComponent(uri.split("/").pop() ?? "")}`;

export const fileAt = (path: string) => new File(Paths.document, path);

/** Size on disk. Pickers don't always report it, and the server needs it up front. */
export const sizeOf = (a: LocalFile) => a.sizeBytes ?? fileAt(relativePath(a.uri)).size ?? 0;

export function removeLocal(target: { uri: string }) {
  try {
    // A queued upload holds a relative path; a picked file holds a full one.
    (target.uri.includes("://") ? new File(target.uri) : fileAt(target.uri)).delete();
  } catch {
    /* already gone */
  }
}

/** The op-shaped description of a picked file. */
export const toUploadSpec = (f: LocalFile): UploadSpec => ({
  id: f.id,
  fileName: f.fileName,
  mimeType: f.mimeType,
  sizeBytes: sizeOf(f),
  path: relativePath(f.uri),
  ...(f.position ? { position: f.position } : {}),
  ...(f.capturedAt ? { capturedAt: f.capturedAt } : {}),
});

function fromImages(res: ImagePicker.ImagePickerResult, position?: LocalFile["position"]): PickResult {
  if (res.canceled) return { ok: false, reason: "cancelled" };
  // A type the server won't take would only fail later, at upload, with the person long gone.
  const fits = res.assets.flatMap((a) => {
    const mimeType = a.mimeType ?? "image/jpeg";
    return isAllowed(mimeType) && (a.fileSize ?? new File(a.uri).size ?? 0) <= MAX_FILE_BYTES ? [{ ...a, mimeType }] : [];
  });
  const dropped = res.assets.length - fits.length;
  const at = new Date().toISOString();
  return {
    ok: true,
    items: fits.map((a) => {
      const name = a.fileName ?? `photo-${Date.now()}.jpg`;
      return {
        id: uid(),
        kind: "photo" as const,
        uri: keepLocally(a.uri, name),
        fileName: name,
        mimeType: a.mimeType,
        sizeBytes: a.fileSize ?? null,
        capturedAt: at,
        ...(position ? { position } : {}),
      };
    }),
    note: dropped > 0 ? `${dropped} photo${dropped === 1 ? " was" : "s were"} skipped (over ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB, or a type that can't be uploaded).` : undefined,
  };
}

/** Opens the camera. Quality 0.7: field connections are slow, and that is plenty for an asset photo. */
export async function takePhoto(position?: LocalFile["position"]): Promise<PickResult> {
  try {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: "denied", canAskAgain: perm.canAskAgain };
    return fromImages(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.7 }), position);
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export async function choosePhotos(max: number): Promise<PickResult> {
  try {
    return fromImages(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: max > 1, selectionLimit: max, quality: 0.7 }));
  } catch {
    return { ok: false, reason: "failed" };
  }
}
