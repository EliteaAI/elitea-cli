import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Write via temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(path: string, data: string, opts: { mode?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode: opts.mode ?? 0o644 });
  await rename(tmp, path);
}

/**
 * Write a file we don't own: skip if unchanged, otherwise back up the previous
 * content to backupDir first. Returns true when the file changed.
 */
export async function writeWithBackup(path: string, data: string, backupDir: string): Promise<boolean> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing === data) return false;
  if (existing !== undefined) {
    await mkdir(backupDir, { recursive: true });
    await copyFile(path, join(backupDir, `${basename(path)}.${Date.now()}`));
  }
  await writeFileAtomic(path, data);
  return true;
}
