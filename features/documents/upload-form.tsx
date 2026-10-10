"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { ALLOWED_DOCUMENT_MIME, DOCUMENT_BUCKET, DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, documentType } from "@/lib/domain/documents";
import { registerDocument } from "./actions";

function safeFileName(name: string) {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .slice(-120);
  return cleaned || "document";
}

export function UploadForm({ organisationId, preselect }: { organisationId: string; preselect?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState(preselect && documentType(preselect) ? preselect : DOCUMENT_TYPES[0].key);
  const [title, setTitle] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const type = documentType(docType)!;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a file to upload");
    if (file.size > MAX_DOCUMENT_BYTES) return setError("Files can be at most 20 MB");
    if (!ALLOWED_DOCUMENT_MIME.includes(file.type)) return setError("Upload a PDF, image, Word or Excel file");
    if (type.expires && !expiresAt) return setError("Enter the expiry date printed on the document");
    startTransition(async () => {
      const path = `${organisationId}/${crypto.randomUUID()}/${safeFileName(file.name)}`;
      const { error: uploadError } = await getBrowserSupabase().storage.from(DOCUMENT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) return setError(`Upload failed: ${uploadError.message}`);
      const res = await registerDocument({ docType, title: title.trim() || type.label, path, expiresAt: expiresAt || null });
      if (!res.ok) return setError(res.error);
      toast.success("Document saved. The agents will use it on every tender, and any bid stopped at compliance is being re-checked.");
      setTitle("");
      setExpiresAt("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-xl border bg-card p-4" noValidate>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="docType">Document type</Label>
          <NativeSelect id="docType" value={docType} onChange={(e) => setDocType(e.target.value)} disabled={pending}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
          {type.hint && <p className="text-[11px] text-muted-foreground">{type.hint}</p>}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="title">Name</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type.label} maxLength={200} disabled={pending} />
        </div>
        {type.expires && (
          <div className="grid gap-1.5">
            <Label htmlFor="expiresAt">Expiry date</Label>
            <Input id="expiresAt" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={pending} />
            <p className="text-[11px] text-muted-foreground">Compliance flags it before a tender closes after this date.</p>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="file">File</Label>
          <Input id="file" ref={fileRef} type="file" accept={ALLOWED_DOCUMENT_MIME.join(",")} disabled={pending} />
          <p className="text-[11px] text-muted-foreground">PDF, image, Word or Excel, up to 20 MB.</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          <Upload className="size-4" aria-hidden /> {pending ? "Uploading…" : "Upload document"}
        </Button>
      </div>
    </form>
  );
}
