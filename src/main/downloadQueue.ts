import path from 'path';
import { mkdir, stat } from 'fs/promises';
import { BeamerDownloadStatus } from '../common/types';
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
  size?: number;
  beamerId: string;
  beamerName: string;
  priority: number;
  batchNumber: number; // 0 for background jobs
  requeues: number;
  attempt: number;
  written: number;
  availableAt: number;
  seq: number;
};

type Batch = {
  id: number;
  resolve: () => void;
  settled: boolean;
};

type BackgroundJob = {
  dest: string;
  name: string;
  url: string;
  size?: number;
  beamerId: string;
  beamerName: string;
};

type Wave = {
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  unknown: number;
  failures: Map<string, { label: string; reason: string }>; // beamerId -> label + reason
  cancelled: boolean;
};

export type DownloadQueueDeps = {
  onStatus: (status: BeamerDownloadStatus) => void;
  onFileComplete: (dest: string) => void;
};

async function partSize(dest: string, name: string) {
  try {
    return (await stat(path.join(dest, `${name}.part`))).size;
  } catch {
    return 0;
  }
}

export function createDownloadQueue({
  onStatus,
  onFileComplete,
}: DownloadQueueDeps) {
  const queue: DownloadJob[] = [];
  const batches = new Map<number, Batch>();
  let active: {
    job: DownloadJob;
    controller: AbortController;
    reason: 'preempt' | 'cancel' | null;
  } | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let seqCounter = 0;
  let batchCounter = 0;
  let lastSentAt = 0;
  let wave: Wave = {
    totalFiles: 0,
    doneFiles: 0,
    totalBytes: 0,
    doneBytes: 0,
    unknown: 0,
    failures: new Map(),
    cancelled: false,
  };

  /* eslint-disable no-use-before-define */

  const nextSeq = () => {
    seqCounter += 1;
    return seqCounter;
  };

  const isQueuedOrActive = (dest: string, name: string) =>
    queue.some((job) => job.dest === dest && job.name === name) ||
    (active?.job.dest === dest && active?.job.name === name);

  const idle = () => active === null && queue.length === 0;

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

  const resetWave = () => {
    wave = {
      totalFiles: 0,
      doneFiles: 0,
      totalBytes: 0,
      doneBytes: 0,
      unknown: 0,
      failures: new Map(),
      cancelled: false,
    };
  };

  const report = (force = false) => {
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
    if (active) {
      seen.add(active.job.beamerName);
      sources.push(active.job.beamerName);
    }
    queue.forEach((job) => {
      if (!seen.has(job.beamerName)) {
        seen.add(job.beamerName);
        sources.push(job.beamerName);
      }
    });

    let progress = 0;
    const activeBytes = active ? active.job.written : 0;
    const byBytes = wave.unknown === 0 && wave.totalBytes > 0;
    if (byBytes) {
      progress = ((wave.doneBytes + activeBytes) / wave.totalBytes) * 100;
    } else if (wave.totalFiles > 0) {
      progress = (wave.doneFiles / wave.totalFiles) * 100;
    }

    onStatus({
      status: 'downloading',
      progress,
      currentFile: active?.job.name ?? '',
      sources,
      filesDone: wave.doneFiles,
      totalFiles: wave.totalFiles,
      attempt:
        active && active.job.attempt > 1 ? active.job.attempt : undefined,
    });
  };

  const finishWave = () => {
    if (!idle()) {
      return;
    }
    if (wave.cancelled) {
      onStatus({
        status: 'cancelled',
        filesDone: wave.doneFiles,
        totalFiles: wave.totalFiles,
      });
    } else if (wave.failures.size > 0) {
      onStatus({
        status: 'error',
        failedFiles: Array.from(
          wave.failures.values(),
          (failure) => `${failure.label} — ${failure.reason}`,
        ),
      });
    } else if (wave.totalFiles > 0) {
      onStatus({ status: 'success' });
    }
    resetWave();
  };

  const outstanding = (batchNumber: number) =>
    queue.some((job) => job.batchNumber === batchNumber) ||
    active?.job.batchNumber === batchNumber;

  const finalizeIfDone = (batch: Batch) => {
    if (batch.settled || outstanding(batch.id)) {
      return;
    }
    batch.settled = true;
    batches.delete(batch.id);
    batch.resolve();
  };

  const failRestOfBatch = (batch: Batch, reason: string) => {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].batchNumber === batch.id && queue[i].batchNumber > 0) {
        wave.doneFiles += 1;
        wave.doneBytes += Math.max(queue[i].size ?? 0, 0);
        wave.failures.set(queue[i].beamerId, {
          label: queue[i].beamerName,
          reason,
        });
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
    finishWave();
  };

  const runJob = (job: DownloadJob) => {
    const controller = new AbortController();
    active = { job, controller, reason: null };
    const batch = job.batchNumber ? batches.get(job.batchNumber) : undefined;

    job.attempt = 1;
    report(true);
    partSize(job.dest, job.name)
      .then((started) => {
        if (active?.job === job && started > job.written) {
          job.written = started;
          report(true);
        }
        return undefined;
      })
      .catch(() => {});

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
            job.written = written;
            report();
          },
          onAttempt: (n) => {
            job.attempt = n;
            report();
          },
        });
      })
      .then(() => {
        wave.doneFiles += 1;
        wave.doneBytes += Math.max(job.size ?? 0, 0);
        wave.failures.delete(job.beamerId);
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
          report();
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
          report();
          return;
        }
        wave.doneFiles += 1;
        wave.doneBytes += Math.max(job.size ?? 0, 0);
        wave.failures.set(job.beamerId, {
          label: job.beamerName,
          reason: failure.message,
        });
        if (failure.unreachable && batch) {
          failRestOfBatch(batch, failure.message);
        }
        report(true);
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
    eligible.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.batchNumber - a.batchNumber ||
        a.seq - b.seq,
    );
    const job = eligible[0];
    queue.splice(queue.indexOf(job), 1);
    clearWake();
    runJob(job);
  }

  const cancelForeground = () => {
    let removed = false;
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].priority === FOREGROUND) {
        queue.splice(i, 1);
        removed = true;
      }
    }
    if (active && active.job.priority === FOREGROUND) {
      active.reason = 'cancel';
      active.controller.abort();
      removed = true;
    }
    batches.forEach((batch) => {
      if (!batch.settled && !outstanding(batch.id)) {
        finalizeIfDone(batch);
      }
    });
    if (removed) {
      wave.cancelled = true;
    }
    report(true);
    finishWave();
  };

  const enqueueBackground = (job: BackgroundJob) => {
    if (isQueuedOrActive(job.dest, job.name)) {
      return;
    }
    wave.totalFiles += 1;
    if (job.size != null) {
      wave.totalBytes += Math.max(job.size ?? 0, 0);
    } else {
      wave.unknown += 1;
    }
    queue.push({
      dest: job.dest,
      name: job.name,
      url: job.url,
      size: job.size,
      beamerId: job.beamerId,
      beamerName: job.beamerName,
      priority: BACKGROUND,
      batchNumber: 0,
      requeues: 0,
      attempt: 1,
      written: 0,
      availableAt: 0,
      seq: nextSeq(),
    });
    report(true);
    drain();
  };

  const enqueueForegroundBatch = async (
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
      const pending = missing.filter(
        (file) => !isQueuedOrActive(dest, file.name),
      );
      if (pending.length === 0) {
        resolve();
        return;
      }
      wave.cancelled = false;
      batchCounter += 1;
      const batchNumber = batchCounter;
      const batch: Batch = { id: batchNumber, resolve, settled: false };
      batches.set(batchNumber, batch);
      if (
        active &&
        active.job.priority < FOREGROUND &&
        active.reason === null
      ) {
        active.reason = 'preempt';
        active.controller.abort();
      }
      pending.forEach((file) => {
        wave.totalFiles += 1;
        if (file.size != null) {
          wave.totalBytes += Math.max(file.size ?? 0, 0);
        } else {
          wave.unknown += 1;
        }
        queue.push({
          dest,
          name: file.name,
          url: file.url,
          size: file.size,
          beamerId,
          beamerName,
          priority: FOREGROUND,
          batchNumber,
          requeues: 0,
          attempt: 1,
          written: 0,
          availableAt: 0,
          seq: nextSeq(),
        });
      });
      report(true);
      drain();
    });
  };

  const clear = () => {
    queue.length = 0;
    clearWake();
    resetWave();
    lastSentAt = 0;
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

export type DownloadQueue = ReturnType<typeof createDownloadQueue>;
