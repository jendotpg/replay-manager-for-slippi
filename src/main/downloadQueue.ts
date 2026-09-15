import path from 'path';
import { mkdir, stat } from 'fs/promises';
import { SlpDownloadStatus } from '../common/types';
import { BeamerFile, hasCompleteFile } from './beamer';
import { DownloadError, downloadFile } from './util';

const FOREGROUND = 1;
const BACKGROUND = 0;
const MAX_REQUEUES = 5;
const STATUS_THROTTLE_MS = 100;

type DownloadJob = {
  dest: string;
  name: string;
  url: string;
  size: number; // -1 when unknown
  batchId: string; // '' for background jobs
  source: string; // station label, for the snackbar
  priority: number;
  requeues: number;
  availableAt: number;
  seq: number;
};

type Batch = {
  id: string;
  source: string;
  slpUrls: string[];
  totalFiles: number;
  byBytes: boolean;
  totalBytes: number;
  bytesWritten: Map<string, number>;
  filesDone: number;
  completed: number;
  failures: Map<string, string>;
  highWater: number;
  attempt: number;
  resolve: () => void;
  settled: boolean;
  cancelled: boolean;
};

type BackgroundJob = { dest: string; name: string; url: string; size: number };

export type DownloadQueueDeps = {
  onStatus: (status: SlpDownloadStatus) => void;
  onFileComplete: (dest: string) => void;
};

export function createDownloadQueue({
  onStatus,
  onFileComplete,
}: DownloadQueueDeps) {
  const queue: DownloadJob[] = [];
  const batches = new Map<string, Batch>();
  let active: {
    job: DownloadJob;
    controller: AbortController;
    reason: 'preempt' | 'cancel' | null;
  } | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let seqCounter = 0;
  let lastSentAt = 0;

  // drain, runJob and finishActive form one co-recursive cluster (a finished
  // download drains the next, which runs the next job); there is no ordering
  // that satisfies no-use-before-define for all three.
  /* eslint-disable no-use-before-define */

  const nextSeq = () => {
    seqCounter += 1;
    return seqCounter;
  };

  const isQueuedOrActive = (dest: string, name: string) =>
    queue.some((job) => job.dest === dest && job.name === name) ||
    (active?.job.dest === dest && active?.job.name === name);

  const clearWake = () => {
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  };

  const scheduleWake = (ms: number) => {
    clearWake();
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null;
        drain();
      },
      Math.max(0, ms),
    );
  };

  const sendBatch = (batch: Batch, currentFile: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastSentAt < STATUS_THROTTLE_MS) {
      return;
    }
    lastSentAt = now;
    let done = 0;
    batch.bytesWritten.forEach((bytes) => {
      done += bytes;
    });
    const progress = batch.byBytes
      ? (done / batch.totalBytes) * 100
      : (batch.filesDone / batch.totalFiles) * 100;
    batch.highWater = Math.max(batch.highWater, progress);
    onStatus({
      status: 'downloading',
      slpUrls: batch.slpUrls,
      progress: batch.highWater,
      currentFile,
      source: batch.source,
      filesDone: batch.filesDone,
      totalFiles: batch.totalFiles,
      attempt: batch.attempt,
    });
  };

  const outstanding = (batchId: string) =>
    queue.some((job) => job.batchId === batchId) ||
    active?.job.batchId === batchId;

  const finalizeIfDone = (batch: Batch) => {
    if (batch.settled || outstanding(batch.id)) {
      return;
    }
    batch.settled = true;
    batches.delete(batch.id);
    if (batch.cancelled) {
      onStatus({
        status: 'cancelled',
        filesDone: batch.completed,
        totalFiles: batch.totalFiles,
      });
    } else if (batch.failures.size > 0) {
      onStatus({
        status: 'error',
        failedFiles: Array.from(
          batch.failures,
          ([name, reason]) => `${name} — ${reason}`,
        ),
      });
    } else {
      onStatus({ status: 'success' });
    }
    batch.resolve();
  };

  const failRestOfBatch = (batch: Batch, reason: string) => {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].batchId === batch.id) {
        batch.failures.set(queue[i].name, reason);
        queue.splice(i, 1);
      }
    }
  };

  const requeue = (job: DownloadJob, availableAt: number, toTail: boolean) => {
    job.availableAt = availableAt;
    if (toTail) {
      job.seq = nextSeq();
    }
    queue.push(job);
  };

  const finishActive = (batch?: Batch) => {
    active = null;
    if (batch) {
      finalizeIfDone(batch);
    }
    drain();
  };

  const runJob = (job: DownloadJob) => {
    const controller = new AbortController();
    active = { job, controller, reason: null };
    const batch = job.batchId ? batches.get(job.batchId) : undefined;

    if (batch) {
      batch.attempt = 1;
      sendBatch(batch, job.name, true);
      partSize(job.dest, job.name)
        .then((started) => {
          if (batch && !batch.bytesWritten.has(job.name)) {
            batch.bytesWritten.set(job.name, started);
            sendBatch(batch, job.name);
          }
          return undefined;
        })
        .catch(() => {});
    }

    mkdir(job.dest, { recursive: true })
      .then(() =>
        hasCompleteFile(job.dest, {
          name: job.name,
          size: job.size,
          url: job.url,
        }),
      )
      .then((complete) => {
        if (complete) {
          return undefined;
        }
        return downloadFile(job.url, path.join(job.dest, job.name), {
          beamerResume: true,
          expectedSize: job.size,
          signal: controller.signal,
          onChunk: (written) => {
            if (batch) {
              batch.bytesWritten.set(job.name, written);
              sendBatch(batch, job.name);
            }
          },
          onAttempt: (n) => {
            if (batch) {
              batch.attempt = n;
              sendBatch(batch, job.name);
            }
          },
        });
      })
      .then(() => {
        if (batch) {
          batch.bytesWritten.set(job.name, Math.max(job.size, 0));
          batch.completed += 1;
          batch.filesDone += 1;
          batch.failures.delete(job.name);
          sendBatch(batch, job.name, true);
        }
        onFileComplete(job.dest);
        finishActive(batch);
        return undefined;
      })
      .catch((error) => {
        const reason = active?.reason ?? null;
        if (reason === 'cancel') {
          finishActive(batch);
          return;
        }
        if (reason === 'preempt') {
          active = null;
          requeue(job, Date.now(), false);
          drain();
          return;
        }
        const failure =
          error instanceof DownloadError
            ? error
            : new DownloadError(
                error instanceof Error ? error.message : String(error),
              );
        if (failure.retryAfterMs !== undefined && job.requeues < MAX_REQUEUES) {
          active = null;
          job.requeues += 1;
          requeue(job, Date.now() + failure.retryAfterMs, true);
          drain();
          return;
        }
        if (batch) {
          batch.failures.set(job.name, failure.message);
          batch.filesDone += 1;
          if (failure.unreachable) {
            failRestOfBatch(batch, failure.message);
          }
          sendBatch(batch, job.name, true);
        }
        finishActive(batch);
      });
  };

  function drain() {
    if (active) {
      return;
    }
    const now = Date.now();
    const eligible = queue.filter((job) => job.availableAt <= now);
    if (eligible.length === 0) {
      if (queue.length > 0) {
        const soonest = Math.min(...queue.map((job) => job.availableAt));
        scheduleWake(soonest - now);
      }
      return;
    }
    eligible.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const job = eligible[0];
    queue.splice(queue.indexOf(job), 1);
    clearWake();
    runJob(job);
  }

  const cancelForeground = () => {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].priority === FOREGROUND) {
        const batch = batches.get(queue[i].batchId);
        if (batch) {
          batch.cancelled = true;
        }
        queue.splice(i, 1);
      }
    }
    if (active && active.job.priority === FOREGROUND) {
      const batch = batches.get(active.job.batchId);
      if (batch) {
        batch.cancelled = true;
      }
      active.reason = 'cancel';
      active.controller.abort();
    } else {
      batches.forEach((batch) => {
        if (batch.cancelled) {
          finalizeIfDone(batch);
        }
      });
    }
  };

  const enqueueBackground = (job: BackgroundJob) => {
    if (isQueuedOrActive(job.dest, job.name)) {
      return;
    }
    queue.push({
      ...job,
      batchId: '',
      source: '',
      priority: BACKGROUND,
      requeues: 0,
      availableAt: 0,
      seq: nextSeq(),
    });
    drain();
  };

  const enqueueForegroundBatch = async (
    dest: string,
    files: BeamerFile[],
    source: string,
  ): Promise<void> => {
    cancelForeground();

    const present = await Promise.all(
      files.map((file) => hasCompleteFile(dest, file)),
    );
    const missing = files.filter((file, i) => !present[i]);

    return new Promise<void>((resolve) => {
      if (missing.length === 0) {
        onStatus({ status: 'success' });
        resolve();
        return;
      }
      const id = `fg-${nextSeq()}`;
      const totalBytes = missing.reduce(
        (sum, file) => sum + Math.max(file.size, 0),
        0,
      );
      const batch: Batch = {
        id,
        source,
        slpUrls: missing.map((file) => file.url),
        totalFiles: missing.length,
        byBytes: missing.every((file) => file.size >= 0) && totalBytes > 0,
        totalBytes,
        bytesWritten: new Map(),
        filesDone: 0,
        completed: 0,
        failures: new Map(),
        highWater: 0,
        attempt: 1,
        resolve,
        settled: false,
        cancelled: false,
      };
      batches.set(id, batch);
      // Preempt a running background job so the foreground batch starts now.
      if (
        active &&
        active.job.priority < FOREGROUND &&
        active.reason === null
      ) {
        active.reason = 'preempt';
        active.controller.abort();
      }
      missing.forEach((file) => {
        queue.push({
          dest,
          name: file.name,
          url: file.url,
          size: file.size,
          batchId: id,
          source,
          priority: FOREGROUND,
          requeues: 0,
          availableAt: 0,
          seq: nextSeq(),
        });
      });
      drain();
    });
  };

  const clear = () => {
    queue.length = 0;
    clearWake();
    if (active) {
      active.reason = 'cancel';
      active.controller.abort();
    }
    batches.forEach((batch) => {
      if (!batch.settled) {
        batch.settled = true;
        batch.resolve();
      }
    });
    batches.clear();
  };

  /* eslint-enable no-use-before-define */

  return {
    enqueueBackground,
    enqueueForegroundBatch,
    cancelForeground,
    clear,
  };
}

async function partSize(dest: string, name: string) {
  try {
    return (await stat(path.join(dest, `${name}.part`))).size;
  } catch {
    return 0;
  }
}

export type DownloadQueue = ReturnType<typeof createDownloadQueue>;
