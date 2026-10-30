import type { DeployRequest, Job, JobSummary, Pairing } from "../shared/rpc";
import { DeployJob, type DeployDependencies } from "./deploy";

/** Each deploy holds an ssh process and possibly a long npm install on the remote machine. */
const MAX_RUNNING = 4;
/** Finished deploys stay visible until this many newer ones finish. */
const MAX_FINISHED = 20;

export class TooManyDeploysError extends Error {
  constructor() {
    super(`At most ${MAX_RUNNING} deploys can run at once.`);
    this.name = "TooManyDeploysError";
  }
}

/** Deploys live in the plugin process; a plugin reload or daemon restart cancels them. */
export class DeployJobs {
  private readonly jobs = new Map<string, DeployJob>();

  start(request: DeployRequest, deps: DeployDependencies): string {
    const running = [...this.jobs.values()].filter((job) => !job.finished).length;
    if (running >= MAX_RUNNING) throw new TooManyDeploysError();
    const job = new DeployJob(request, deps);
    this.jobs.set(job.id, job);
    void job.run().finally(() => this.prune());
    return job.id;
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map((job) => job.summary()).reverse();
  }

  get(jobId: string): Job | null {
    return this.jobs.get(jobId)?.snapshot() ?? null;
  }

  pairing(jobId: string): Pairing | null {
    return this.jobs.get(jobId)?.pairing() ?? null;
  }

  answer(jobId: string, promptId: string, value: string | null): boolean {
    return this.jobs.get(jobId)?.answer(promptId, value) ?? false;
  }

  cancel(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancel() ?? false;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.cancel();
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((job) => job.finished);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.jobs.delete(job.id);
    }
  }
}
