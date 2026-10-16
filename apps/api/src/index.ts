import 'dotenv/config';
import { startApi } from './runtime';

const api = await startApi();
console.log(
  `Aftermath API: ${api.url} — deterministic reports, ${api.service.ledger.kind} + FalkorDB + BullMQ`,
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await api.close();
  } catch (error) {
    console.error('API shutdown failed:', error);
    process.exitCode = 1;
  }
}
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
