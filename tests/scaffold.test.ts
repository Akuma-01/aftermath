import { expect, it } from 'vitest';

const workspaces = [
  '@aftermath/contracts',
  '@aftermath/domain',
  '@aftermath/fixtures',
  '@aftermath/graph',
  '@aftermath/storage',
  '@aftermath/repair',
  '@aftermath/queue',
  '@aftermath/agents',
  '@aftermath/evaluation',
];

it.each(workspaces)('resolves the TypeScript source export of %s', async (name) => {
  await expect(import(name)).resolves.toBeDefined();
});
