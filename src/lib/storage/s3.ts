import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { EvidenceStore } from "./index";

type S3Options = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export class S3Store implements EvidenceStore {
  readonly driver = "s3" as const;
  private readonly client: S3Client;
  private bucketReady: Promise<void> | undefined;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint || undefined,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  /** Creates the bucket on first use (convenient for MinIO); a no-op when it already exists. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.opts.bucket }));
      }
    })();
    return this.bucketReady;
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentType: contentType }));
    return { key, url: `s3://${this.opts.bucket}/${key}` };
  }

  async get(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!out.Body) throw new Error(`Empty object: ${key}`);
    return { body: Buffer.from(await out.Body.transformToByteArray()), contentType: out.ContentType ?? "application/octet-stream" };
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
