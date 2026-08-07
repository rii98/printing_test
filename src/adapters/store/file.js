/**
 * File-backed durable job store. Each pending job is one JSON file in <dir>/pending;
 * jobs that exhaust retries move to <dir>/dead for inspection. Writes are atomic
 * (temp file + rename) so a crash mid-write never corrupts a job. On boot the
 * queue calls list() to recover and re-drain anything left behind.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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
  const jobFile = (id) => path.join(pendingDir, `${id}.json`);

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
      await writeAtomic(path.join(deadDir, `${job.id}.json`), { ...job, diedAt: Date.now() });
      await fs.rm(jobFile(job.id), { force: true });
    },
    async listDead() {
      const files = (await fs.readdir(deadDir)).filter((f) => f.endsWith('.json'));
      return Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(deadDir, f), 'utf8'))));
    },
  };
}
