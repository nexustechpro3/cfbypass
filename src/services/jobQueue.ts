import { randomUUID } from 'crypto'
import type { Job, SolverMode } from '../types'
import { JOB_TTL_MS } from '../constants'

const jobs: Map<string, Job> = new Map()

export function mkJob(meta?: { url: string; mode: SolverMode }): string {
  const id = randomUUID()
  jobs.set(id, {
    status: 'pending',
    result: null,
    error: null,
    createdAt: Date.now(),
    mode: meta?.mode,
    url: meta?.url,
  })
  return id
}

export function resolveJob(id: string, result: unknown): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = 'done'
  job.result = result
}

export function rejectJob(id: string, error: string): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = 'failed'
  job.error = error
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function listJobs(limit = 50): Array<{ jobId: string } & Job> {
  const all = [...jobs.entries()]
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, limit)
  return all.map(([jobId, job]) => ({ jobId, ...job }))
}

// TTL cleanup — runs every 60 seconds
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) jobs.delete(id)
  }
}, 60_000)

cleanupTimer.unref()
