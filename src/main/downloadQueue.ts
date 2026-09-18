import path from 'path';
import { mkdir } from 'fs/promises';
import { EventEmitter } from 'events';
import { BeamerFile, DownloadStatus } from '../common/types';
import {
  DownloadError,
  downloadFile,
  hasCompleteFile,
  sizeOf,
  toDownloadError,
} from './download';

const MAX_REQUEUES = 5;
const STATUS_THROTTLE_MS = 100;

export type JobPriority = 'low' | 'high';

export type BeamerDownloadRequest = {
  dest: string;
  name: string;
  url: string;
  size?: number;
  beamerId: string;
  beamerName: string;
};

type Batch = {
  seq: number;
  remaining: number;
  settled: boolean;
  resolve: () => void;
};

type Job = {
  request: BeamerDownloadRequest;
  priority: JobPriority;
  batch: Batch;
  waitUntil: number;
  totalAttempts: number;
  written: number;
  currentFileAttempts: number;
  aborted?: 'preempt' | 'cancel';
  settled: boolean;
};

type BeamerWave = {
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  unknown: number;
  failures: Map<string, { label: string; reason: string }>;
  cancelled: boolean;
};

export const beamerFileComplete = new EventEmitter<{
  fileComplete: [dest: string];
}>();

function freshWave(): BeamerWave {
  return {
    totalFiles: 0,
    doneFiles: 0,
    totalBytes: 0,
    doneBytes: 0,
    unknown: 0,
    failures: new Map(),
    cancelled: false,
  };
}

const jobs: Job[] = [];
const batches = new Set<Batch>();
let running: { job: Job; controller: AbortController } | null = null;
let wave = freshWave();
let wakeTimer: NodeJS.Timeout | null = null;
let batchCounter = 0;
let lastSentAt = 0;

let sendStatusTo: (status: DownloadStatus) => void = () => {};

export function initDownloadQueue(
  sendStatus: (status: DownloadStatus) => void,
) {
  sendStatusTo = sendStatus;
}

const isPending = (dest: string, name: string) =>
  jobs.some((job) => job.request.dest === dest && job.request.name === name);

const idle = () => running === null && jobs.length === 0;

const clearWake = () => {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
};

const sendStatus = (force = false) => {
  const now = Date.now();
  if (!force && now - lastSentAt < STATUS_THROTTLE_MS) {
    return;
  }
  if (idle()) {
    return;
  }
  lastSentAt = now;

  const sources: string[] = [];
  const seen = new Set<string>();
  const addSource = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      sources.push(name);
    }
  };
  if (running) {
    addSource(running.job.request.beamerName);
  }
  jobs.forEach((job) => addSource(job.request.beamerName));

  let progress = 0;
  const activeBytes = running ? running.job.written : 0;
  const byBytes = wave.unknown === 0 && wave.totalBytes > 0;
  if (byBytes) {
    progress = ((wave.doneBytes + activeBytes) / wave.totalBytes) * 100;
  } else if (wave.totalFiles > 0) {
    progress = (wave.doneFiles / wave.totalFiles) * 100;
  }

  sendStatusTo({
    status: 'downloading',
    progress,
    currentFile: running?.job.request.name ?? '',
    sources,
    filesDone: wave.doneFiles,
    totalFiles: wave.totalFiles,
    attempt:
      running && running.job.currentFileAttempts > 1
        ? running.job.currentFileAttempts
        : undefined,
  });
};

const finishWave = () => {
  if (!idle()) {
    return;
  }
  if (wave.cancelled) {
    sendStatusTo({
      status: 'cancelled',
      filesDone: wave.doneFiles,
      totalFiles: wave.totalFiles,
    });
  } else if (wave.failures.size > 0) {
    sendStatusTo({
      status: 'error',
      failedFiles: Array.from(wave.failures.values()),
    });
  } else if (wave.totalFiles > 0) {
    sendStatusTo({ status: 'success' });
  }
  wave = freshWave();
};

const leaveBatch = (batch: Batch) => {
  batch.remaining -= 1;
  if (batch.remaining > 0 || batch.settled) {
    return;
  }
  batch.settled = true;
  batches.delete(batch);
  batch.resolve();
};

type JobOutcome = { kind: 'done' } | { kind: 'failed'; failure: DownloadError };

const settle = (job: Job, outcome: JobOutcome) => {
  if (job.settled) {
    return;
  }
  job.settled = true;
  const index = jobs.indexOf(job);
  if (index >= 0) {
    jobs.splice(index, 1);
  }
  if (running?.job === job) {
    running = null;
  }
  wave.doneFiles += 1;
  wave.doneBytes += Math.max(job.request.size ?? 0, 0);
  if (outcome.kind === 'done') {
    wave.failures.delete(job.request.beamerId);
    beamerFileComplete.emit('fileComplete', job.request.dest);
  } else {
    wave.failures.set(job.request.beamerId, {
      label: job.request.beamerName,
      reason: outcome.failure.message,
    });
    if (outcome.failure.unreachable) {
      // the beamer is down - fail the rest of its batch right away
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        const sibling = jobs[i];
        if (sibling.batch === job.batch) {
          sibling.settled = true;
          jobs.splice(i, 1);
          wave.doneFiles += 1;
          wave.doneBytes += Math.max(sibling.request.size ?? 0, 0);
          wave.failures.set(sibling.request.beamerId, {
            label: sibling.request.beamerName,
            reason: outcome.failure.message,
          });
          leaveBatch(sibling.batch);
        }
      }
    }
  }
  leaveBatch(job.batch);
  sendStatus(true);
  // eslint-disable-next-line no-use-before-define
  pump();
  finishWave();
};

const byRunOrder = (a: Job, b: Job) => {
  const byPriority =
    (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0);
  if (byPriority !== 0) {
    return byPriority;
  }
  return b.batch.seq - a.batch.seq;
};

const scheduleWake = (ms: number) => {
  clearWake();
  wakeTimer = setTimeout(
    () => {
      wakeTimer = null;
      // eslint-disable-next-line no-use-before-define
      pump();
    },
    Math.max(0, ms),
  );
};

const pump = () => {
  if (running) {
    return;
  }
  jobs.sort(byRunOrder);
  const next = jobs.findIndex((job) => job.waitUntil <= Date.now());
  if (next >= 0) {
    clearWake();
    // eslint-disable-next-line no-use-before-define
    runJob(jobs[next]); // the job stays in the list until it settles
    return;
  }
  if (jobs.length > 0) {
    scheduleWake(Math.min(...jobs.map((job) => job.waitUntil)) - Date.now());
  }
};

const runJob = (job: Job) => {
  const controller = new AbortController();
  running = { job, controller };
  job.currentFileAttempts = 1;
  sendStatus(true);
  sizeOf(path.join(job.request.dest, `${job.request.name}.part`))
    .then((started) => {
      if (running?.job === job && started > job.written) {
        job.written = started;
        sendStatus(true);
      }
      return undefined;
    })
    .catch(() => {});

  mkdir(job.request.dest, { recursive: true })
    .then(() => hasCompleteFile(job.request.dest, job.request))
    .then((complete) => {
      if (complete) {
        return undefined;
      }
      return downloadFile(
        job.request.url,
        path.join(job.request.dest, job.request.name),
        {
          beamerResume: true,
          expectedSize: job.request.size,
          signal: controller.signal,
          onChunk: (written) => {
            job.written = written;
            sendStatus();
          },
          onAttempt: (attempt) => {
            job.currentFileAttempts = attempt;
            sendStatus();
          },
        },
      );
    })
    .then(() => settle(job, { kind: 'done' }))
    .catch((error) => {
      if (running?.job !== job) {
        return; // a newer run owns the engine; this catch is stale
      }
      running = null;
      const interrupted = job.aborted;
      job.aborted = undefined;
      if (interrupted) {
        finishWave();
        pump();
        return;
      }
      const failure = toDownloadError(error);
      if (
        failure.retryAfterMs !== undefined &&
        job.totalAttempts < MAX_REQUEUES
      ) {
        job.totalAttempts += 1;
        job.waitUntil = Date.now() + failure.retryAfterMs;
        jobs.splice(jobs.indexOf(job), 1);
        jobs.push(job); // back of its class; it waits out the Retry-After
        sendStatus();
        pump();
        finishWave();
        return;
      }
      settle(job, { kind: 'failed', failure });
    });
};

const preemptRunning = () => {
  if (!running || running.job.priority !== 'low' || running.job.aborted) {
    return;
  }
  running.job.aborted = 'preempt';
  running.controller.abort();
};

export function cancelBeamerDownload() {
  const dropped = jobs.splice(0);
  dropped.forEach((job) => {
    job.settled = true;
  });
  clearWake();
  if (running) {
    running.job.aborted = 'cancel';
    running.controller.abort();
    running = null;
  }
  batches.forEach((batch) => {
    if (!batch.settled) {
      batch.settled = true;
      batches.delete(batch);
      batch.resolve();
    }
  });
  if (dropped.length > 0 || running) {
    wave.cancelled = true;
  }
  sendStatus(true);
  finishWave();
}

export const enqueueBeamerDownload = (
  request: BeamerDownloadRequest,
  priority: JobPriority = 'low',
) => {
  if (isPending(request.dest, request.name)) {
    return;
  }
  wave.totalFiles += 1;
  if (request.size != null) {
    wave.totalBytes += Math.max(request.size ?? 0, 0);
  } else {
    wave.unknown += 1;
  }
  jobs.push({
    request,
    priority,
    batch: {
      seq: 0,
      remaining: 1,
      settled: false,
      resolve: () => {},
    },
    waitUntil: 0,
    totalAttempts: 0,
    currentFileAttempts: 1,
    written: 0,
    settled: false,
  });
  sendStatus(true);
  pump();
};

export const enqueueBeamerPull = async (
  dest: string,
  files: BeamerFile[],
  beamerId: string,
  beamerName: string,
): Promise<void> => {
  const present = await Promise.all(
    files.map((file) => hasCompleteFile(dest, file)),
  );
  const missing = files.filter((file, i) => !present[i]);

  return new Promise<void>((resolve) => {
    const pending = missing.filter((file) => !isPending(dest, file.name));
    if (pending.length === 0) {
      resolve();
      return;
    }
    wave.cancelled = false;
    batchCounter += 1;
    const batch: Batch = {
      seq: batchCounter,
      remaining: pending.length,
      settled: false,
      resolve,
    };
    batches.add(batch);
    preemptRunning();
    pending.forEach((file) => {
      wave.totalFiles += 1;
      if (file.size != null) {
        wave.totalBytes += Math.max(file.size ?? 0, 0);
      } else {
        wave.unknown += 1;
      }
      jobs.push({
        request: {
          dest,
          name: file.name,
          url: file.url,
          size: file.size,
          beamerId,
          beamerName,
        },
        priority: 'high',
        batch,
        waitUntil: 0,
        totalAttempts: 0,
        currentFileAttempts: 1,
        written: 0,
        settled: false,
      });
    });
    sendStatus(true);
    pump();
  });
};

export function prioritizeBeamer(beamerId: string) {
  let raised = false;
  jobs.forEach((job) => {
    if (job.request.beamerId === beamerId && job.priority === 'low') {
      job.priority = 'high';
      raised = true;
    }
  });
  if (raised && running?.job.request.beamerId !== beamerId) {
    preemptRunning();
  }
  if (raised) {
    sendStatus();
    pump();
  }
}
