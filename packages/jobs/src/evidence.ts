import fs from "node:fs";
import path from "node:path";
import { digest, type ArtifactStore } from "./artifacts.js";
import type { FileUpload } from "./adapters/application.js";

/** A posting capture older than this is stale evidence for preparing or sending. */
export const MAX_CAPTURE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Stable digest of a JSON value; used to detect a changed manifest or reviewed field. */
export const jsonDigest = (value: unknown): string => digest(Buffer.from(JSON.stringify(value), "utf8"));

export const resumeFilename = (applicationId: string): string => `resume-${applicationId.slice(0, 8)}.txt`;

/**
 * The resume as a site receives it. The artifact store is content-addressed, so a raw
 * artifact path would present a file named after its digest: a verified copy is staged
 * under the application's own name, and the upload still records the artifact hash the
 * bytes must match. `bytes` may be passed when the caller has already verified them.
 */
export function resumeUpload(artifacts: ArtifactStore, applicationId: string, hash: string, bytes: Buffer = artifacts.read(hash)): FileUpload {
  // Concurrent preparations must not overwrite the bytes another browser will upload.
  const directory = path.join(artifacts.root, "uploads", digest(bytes));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, resumeFilename(applicationId));
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { field: "resume", artifactHash: hash, filename: resumeFilename(applicationId), mimeType: "text/plain", localPath: file };
}
