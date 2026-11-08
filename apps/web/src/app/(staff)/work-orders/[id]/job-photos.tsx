"use client";

import { FILE_MIME_TYPES, type FileMimeType } from "@flowless/shared-types";
import { CameraIcon, FileTextIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { JobFile } from "@/data/work-orders";
import { formatWhen } from "@/lib/dates";
import { formatPosition } from "@/lib/use-position";
import { announceFile, confirmFile, removeFile } from "../actions";

const isMime = (type: string): type is FileMimeType => (FILE_MIME_TYPES as readonly string[]).includes(type);

/** The device position for a photo, if it is already allowed; never prompts on its own. */
function currentPosition(): Promise<{ latitude: number; longitude: number } | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(undefined),
      { timeout: 4000, maximumAge: 60_000 },
    );
  });
}

/**
 * Photos and documents on a job (K-08): announce, PUT the bytes straight to storage with the
 * presigned URL, then confirm so the server checks the size. The page refreshes after each.
 */
export function JobPhotos({
  workOrderId,
  files,
  required,
  canAdd,
  locale,
  timeZone,
}: {
  workOrderId: string;
  files: JobFile[];
  required: number;
  canAdd: boolean;
  locale: string;
  timeZone: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        if (!isMime(file.type)) {
          toast.error(`${file.name}: only JPEG, PNG, WebP, HEIC and PDF files can be added`);
          continue;
        }
        const id = crypto.randomUUID();
        const announced = await announceFile({
          id,
          workOrderId,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          position: await currentPosition(),
          capturedAt: new Date(file.lastModified).toISOString(),
        });
        if (announced.error !== null) {
          toast.error(`${file.name}: ${announced.error}`);
          continue;
        }
        const target = announced.data.upload;
        if (!target || !/^https?:/.test(target.url)) {
          toast.error("File storage isn't set up for this environment, so uploads can't be saved.");
          break;
        }
        const put = await fetch(target.url, { method: "PUT", headers: target.headers, body: file }).catch(() => null);
        if (!put?.ok) {
          toast.error(`${file.name}: the upload didn't finish. Try again.`);
          continue;
        }
        const confirmed = await confirmFile(id);
        if (confirmed.error !== null) toast.error(`${file.name}: ${confirmed.error}`);
        else if (confirmed.data.problem) toast.error(confirmed.data.problem);
        else toast.success(`${file.name} added`);
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const photos = files.filter((f) => f.kind === "photo");
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground tabular">
          {photos.length} {photos.length === 1 ? "photo" : "photos"}
          {required > 0 && ` (${required} required to finish)`}
        </p>
        {canAdd && (
          <>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" capture="environment" multiple hidden onChange={(e) => upload(e.target.files)} />
            <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
              <CameraIcon />
              {busy ? "Uploading..." : "Add photo"}
            </Button>
          </>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing attached yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Attachments">
          {files.map((f) => (
            <li key={f.id} className="grid gap-1.5 rounded-xl border bg-card p-2">
              {f.kind === "photo" ? (
                // Presigned, short-lived URLs from the file service; next/image would proxy them.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt={f.fileName} className="aspect-4/3 w-full rounded-lg bg-muted object-cover" loading="lazy" />
              ) : (
                <a href={f.url} className="flex aspect-4/3 items-center justify-center rounded-lg bg-muted" target="_blank" rel="noreferrer">
                  <FileTextIcon className="size-8 text-muted-foreground" />
                </a>
              )}
              <p className="truncate text-xs font-medium">{f.fileName}</p>
              <p className="text-xs text-muted-foreground tabular">
                {f.uploadedAt ? formatWhen(f.uploadedAt, locale, timeZone) : ""}
                {f.position && <span className="block">GPS {formatPosition(f.position)}</span>}
              </p>
              {canAdd && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-self-start"
                  onClick={async () => {
                    const result = await removeFile(f.id);
                    if (result.error !== null) toast.error(result.error);
                  }}
                >
                  <Trash2Icon />
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
