/** In-memory job store for tests and for running without persistence. */
export function memoryStore() {
  const pending = new Map();
  const dead = [];
  return {
    async add(job) { pending.set(job.id, job); },
    async update(job) { pending.set(job.id, job); },
    async remove(id) { pending.delete(id); },
    async list() { return [...pending.values()]; },
    async kill(job) { pending.delete(job.id); dead.push(job); },
    async listDead() { return [...dead]; },
  };
}
