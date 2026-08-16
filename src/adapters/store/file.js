/**
 * File-backed durable job store. Each pending job is one JSON file in <dir>/pending;
 * jobs that exhaust retries move to <dir>/dead for inspection. Writes are atomic
 * (temp file + rename) so a crash mid-write never corrupts a job. On boot the
 * queue calls list() to recover and re-drain anything left behind.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Make a job id safe to use as a filename on EVERY platform. A ticket key can
 * contain characters that are legal on macOS/Linux but ILLEGAL on Windows —
 * notably ':' (NTFS reads `name:x` as an alternate-data-stream), which appears in
 * our `bill:<id>@0` and `<id>@0:void` keys. Left raw, the atomic rename fails with
 * EINVAL on Windows and the bill/void slip is never queued, while colon-free
 * KOT/BOT keys (`<id>@0`) work — the exact "kitchen works, billing/void don't"
 * split seen only on the Windows box.
 *
 * We percent-encode the Windows-reserved set (and '%' itself, so the mapping is
 * injective — no two distinct keys collide onto one file). The true id is stored
 * INSIDE the JSON, so list()/recovery read the real key regardless of the on-disk
 * name; this only changes the filename. Keys with none of these characters (every
 * existing KOT file) encode to themselves, so old pending files still load.
 */
const safeName = (id) =>
  String(id).replace(/[%<>:"/\\|?*\x00-\x1f]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());

export async function fileStore(dir) {
  const pendingDir = path.join(dir, 'pending');
  const deadDir = path.join(dir, 'dead');
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.mkdir(deadDir, { recursive: true });

  const writeAtomic = async (file, obj) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj));
    await fs.rename(tmp, file);
  };
  const jobFile = (id) => path.join(pendingDir, `${safeName(id)}.json`);

  return {
    async add(job) { await writeAtomic(jobFile(job.id), job); },
    async update(job) { await writeAtomic(jobFile(job.id), job); },
    async remove(id) { await fs.rm(jobFile(id), { force: true }); },
    async list() {
      const files = (await fs.readdir(pendingDir)).filter((f) => f.endsWith('.json'));
      const jobs = [];
      for (const f of files) {
        try { jobs.push(JSON.parse(await fs.readFile(path.join(pendingDir, f), 'utf8'))); }
        catch { /* skip a corrupt/half-written file */ }
      }
      // Oldest first, so recovery preserves order.
      return jobs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },
    async kill(job) {
      await writeAtomic(path.join(deadDir, `${safeName(job.id)}.json`), { ...job, diedAt: Date.now() });
      await fs.rm(jobFile(job.id), { force: true });
    },
    async listDead() {
      const files = (await fs.readdir(deadDir)).filter((f) => f.endsWith('.json'));
      return Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(deadDir, f), 'utf8'))));
    },
  };
}
