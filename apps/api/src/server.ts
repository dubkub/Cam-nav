import { buildApp } from './app.js';
import { loadConfig, loadWorld } from './config.js';

const config = loadConfig();
const world = await loadWorld(config);
const app = await buildApp({ config, world });

if (world.demoMode) {
  app.log.warn(
    'Running on the synthetic demo city. Set DATASET_PATH to a dataset built by ' +
      'cam-nav-ingest before showing this to anyone as real.',
  );
}

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, closing`);
    void app.close().then(() => process.exit(0));
  });
}
