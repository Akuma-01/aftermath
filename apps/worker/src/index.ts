import 'dotenv/config';
import { startWorker } from './runtime';

const worker = await startWorker();
console.log('Aftermath deterministic repair worker started.');
const keepAlive = setInterval(() => {}, 60000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  try {
    await worker.close();
  } catch (error) {
    console.error('Worker shutdown failed:', error);
    process.exitCode = 1;
  }
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
