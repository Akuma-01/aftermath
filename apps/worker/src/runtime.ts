import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { RepairProcessor } from '@aftermath/repair';
import { queueConnection, RepairRuntime } from '@aftermath/queue';

/** A separate worker must use shared services; it never opens a second PGlite owner. */
export async function startWorker(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL || !env.QUEUE_REDIS_URL || !env.FALKORDB_URL)
    throw new Error('A separate worker requires DATABASE_URL, QUEUE_REDIS_URL and FALKORDB_URL.');
  let ledger: Ledger | undefined;
  let graph: EvidenceGraph | undefined;
  let queue: Awaited<ReturnType<typeof queueConnection>> | undefined;
  let runtime: RepairRuntime | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await runtime?.close();
      } finally {
        try {
          await queue?.close();
        } finally {
          try {
            await graph?.close();
          } finally {
            await ledger?.close();
          }
        }
      }
    })());
  try {
    ledger = await Ledger.open(undefined, env.DATABASE_URL);
    graph = await EvidenceGraph.open(undefined, env.FALKORDB_URL);
    queue = await queueConnection(env.QUEUE_REDIS_URL);
    runtime = new RepairRuntime(
      ledger,
      new RepairProcessor(ledger, graph),
      queue.connection,
      env.QUEUE_NAME,
    );
    await runtime.start();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
