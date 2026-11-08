import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Where file bytes live (K-08), ported from Majimap. The API only ever hands out
 * short-lived URLs, so files never pass through tRPC. Any S3-compatible service works
 * (AWS S3, Cloudflare R2, MinIO, Supabase Storage): see `createS3Storage` below.
 */

export interface Storage {
  presignPut(key: string, opts: { mimeType: string; sizeBytes: number; expiresInSec: number }): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresInSec: number): Promise<string>;
  /** null when there is no such object. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}

/** For tests: remembers what was "uploaded" via `put`. */
export function createMemoryStorage() {
  const objects = new Map<string, number>();
  const storage: Storage = {
    presignPut: async (key) => ({ url: `memory://${key}`, headers: {} }),
    presignGet: async (key) => `memory://${key}`,
    head: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)! } : null),
    delete: async (key) => void objects.delete(key),
  };
  return { storage, put: (key: string, sizeBytes: number) => void objects.set(key, sizeBytes) };
}

export type S3StorageConfig = {
  bucket: string;
  /** "auto" for R2; the AWS region otherwise. */
  region: string;
  /** Omit for AWS. Set for R2 (https://<account>.r2.cloudflarestorage.com), MinIO, etc. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and some self-hosted stores need path-style URLs (endpoint/bucket/key). */
  forcePathStyle?: boolean;
};

/**
 * Storage on any S3-compatible service. Uploads are presigned PUTs that pin the content type and length, so a
 * device can't swap in a different file than the one it announced; `confirm` still checks the size with `head`.
 */
export function createS3Storage(config: S3StorageConfig): Storage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const Bucket = config.bucket;
  return {
    async presignPut(key, { mimeType, sizeBytes, expiresInSec }) {
      const command = new PutObjectCommand({ Bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes });
      const url = await getSignedUrl(client, command, { expiresIn: expiresInSec, signableHeaders: new Set(["content-type", "content-length"]) });
      return { url, headers: { "Content-Type": mimeType, "Content-Length": String(sizeBytes) } };
    },
    presignGet: (key, expiresInSec) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: expiresInSec }),
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { sizeBytes: out.ContentLength ?? 0 };
      } catch (err) {
        if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === "NotFound")) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/**
 * Storage from the environment: S3 when S3_BUCKET is set, otherwise the in-memory store (development only: uploads
 * can't actually land anywhere, so `confirm` will report them missing). Throws in production without S3 settings.
 * Read once per process.
 */
let fromEnv: Storage | undefined;
export function defaultStorage(): Storage {
  return (fromEnv ??= storageFromEnv());
}

export function storageFromEnv(env: Record<string, string | undefined> = process.env): Storage {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) {
    if (env.NODE_ENV === "production") throw new Error("S3_BUCKET is not set: the file service needs a storage bucket in production");
    return createMemoryStorage().storage;
  }
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when S3_BUCKET is set");
  return createS3Storage({
    bucket,
    region: env.S3_REGION?.trim() || "auto",
    ...(env.S3_ENDPOINT?.trim() ? { endpoint: env.S3_ENDPOINT.trim() } : {}),
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  });
}
