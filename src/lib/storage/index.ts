import { env } from "@/env";
import { logger } from "@/lib/logger";
import { LocalStore } from "./local";
import { S3Store } from "./s3";

export interface EvidenceStore {
  readonly driver: "s3" | "local";
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string; url: string }>;
  get(key: string): Promise<{ body: Buffer; contentType: string }>;
  delete(key: string): Promise<void>;
}

let store: EvidenceStore | undefined;

export function evidenceStore(): EvidenceStore {
  if (store) return store;
  const e = env();
  if (e.STORAGE_DRIVER === "local") {
    // A production build on one machine (npm run fast) may legitimately keep evidence on local disk.
    // Hosted deployments should use S3-compatible storage; say so, but serve what is configured.
    if (e.NODE_ENV === "production") logger.warn({ dir: e.STORAGE_LOCAL_DIR }, "STORAGE_DRIVER=local in a production build: evidence lives on this machine only; configure S3-compatible storage for a hosted deployment");
    store = new LocalStore(e.STORAGE_LOCAL_DIR);
  } else {
    if (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) {
      throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3");
    }
    store = new S3Store({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    });
  }
  return store;
}
