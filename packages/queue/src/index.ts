import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Ledger } from '@aftermath/storage';
import type { RepairProcessor } from '@aftermath/repair';
export { queueConnection } from './redis';

export class RepairRuntime {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private lastError: string | null = null;
  private stopping = false;
  private started = false;
  private closing?: Promise<void>;
  constructor(
    readonly ledger: Ledger,
    processor: RepairProcessor,
    connection: ConnectionOptions,
    queueName = 'aftermath-repair',
  ) {
    this.queue = new Queue(queueName, {
      connection: { ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false },
    });
    this.worker = new Worker(queueName, async (job) => processor.process(String(job.data.taskId)), {
      connection: { ...connection, maxRetriesPerRequest: null },
      concurrency: 2,
      autorun: false,
    });
    this.queue.on('error', (error) => this.logError(error));
    this.worker.on('error', (error) => this.logError(error));
    this.worker.on('failed', (_job, error) => this.logError(error));
  }
  private logError(error: Error) {
    if (this.lastError !== error.message) console.error('Repair queue:', error.message);
    this.lastError = error.message;
  }
  async start() {
    if (this.stopping) throw new Error('Repair runtime is closed');
    if (this.started) return;
    this.started = true;
    try {
      await this.ledger.jobs.backfill();
    } catch (error) {
      this.started = false;
      throw error;
    }
    // Network availability does not gate API startup or acceptance of SQL commands.
    void this.worker.run().catch((error) => this.logError(error));
    this.timer = setInterval(() => {
      void this.tick();
    }, 250);
    this.timer.unref();
    await this.tick();
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.dispatch()
      .catch((error) => this.logError(error))
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
  private async dispatch() {
    await this.ledger.jobs.recoverExpired();
    for (const delivery of await this.ledger.jobs.deliveries()) {
      // A Redis restart may lose deliveries. SQL keeps them eligible until a worker claims them.
      const existing = await this.queue.getJob(delivery.id);
      if (existing && ['completed', 'failed'].includes(await existing.getState()))
        await existing.remove();
      await this.queue.add(
        'repair',
        { taskId: delivery.taskId },
        { jobId: delivery.id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
      );
      await this.ledger.jobs.delivered(delivery.id);
    }
    this.lastError = null;
  }
  async close() {
    this.closing ??= (async () => {
      this.stopping = true;
      if (this.timer) clearInterval(this.timer);
      await this.pending;
      try {
        await this.worker.close();
      } finally {
        await this.queue.close();
      }
    })();
    return this.closing;
  }
}
