import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceStore } from "./index";

/** Development-only store. Same interface as S3 so nothing else changes when you switch. */
export class LocalStore implements EvidenceStore {
  readonly driver = "local" as const;
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: Buffer, contentType: string) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.type`, contentType);
    return { key, url: `local://${key}` };
  }

  async get(key: string) {
    const file = this.resolve(key);
    const [body, contentType] = await Promise.all([
      readFile(file),
      readFile(`${file}.type`, "utf8").catch(() => "application/octet-stream"),
    ]);
    return { body, contentType };
  }

  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
  }
}
