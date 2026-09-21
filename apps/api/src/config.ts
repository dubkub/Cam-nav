import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Detector } from '@cam-nav/core';
import { fromFeatureCollection } from '@cam-nav/data';
import type { DetectorFeatureCollection } from '@cam-nav/data';
import {
  GraphRoutingEngine,
  OsrmEngine,
  ValhallaEngine,
  createDemoCity,
} from '@cam-nav/routing';
import type { RoadNetworkGeoJson, RoutingEngine } from '@cam-nav/routing';

export interface ServerConfig {
  port: number;
  host: string;
  /** Path to a detectors.geojson produced by cam-nav-ingest. */
  datasetPath?: string;
  /** Path to a road network GeoJSON, required by the built-in graph engine. */
  roadNetworkPath?: string;
  engine: 'graph' | 'valhalla' | 'osrm';
  valhallaUrl?: string;
  osrmUrl?: string;
  /** Salt for hashing report submitters. Must be set in production. */
  reportSalt: string;
  corsOrigin: string;
  requestsPerMinute: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const engine = (env['ROUTING_ENGINE'] ?? 'graph') as ServerConfig['engine'];
  if (!['graph', 'valhalla', 'osrm'].includes(engine)) {
    throw new Error(`ROUTING_ENGINE must be graph, valhalla or osrm (got ${engine})`);
  }
  if (engine === 'valhalla' && !env['VALHALLA_URL']) throw new Error('VALHALLA_URL is required');
  if (engine === 'osrm' && !env['OSRM_URL']) throw new Error('OSRM_URL is required');

  const salt = env['REPORT_SALT'];
  if (env['NODE_ENV'] === 'production' && !salt) {
    throw new Error('REPORT_SALT must be set in production; reporter hashes are useless without it');
  }

  const config: ServerConfig = {
    port: Number(env['PORT'] ?? 8787),
    host: env['HOST'] ?? '0.0.0.0',
    engine,
    reportSalt: salt ?? 'development-salt-not-for-production',
    corsOrigin: env['CORS_ORIGIN'] ?? '*',
    requestsPerMinute: Number(env['RATE_LIMIT_PER_MINUTE'] ?? 60),
    logLevel: env['LOG_LEVEL'] ?? 'info',
  };
  if (env['DATASET_PATH']) config.datasetPath = env['DATASET_PATH'];
  if (env['ROAD_NETWORK_PATH']) config.roadNetworkPath = env['ROAD_NETWORK_PATH'];
  if (env['VALHALLA_URL']) config.valhallaUrl = env['VALHALLA_URL'];
  if (env['OSRM_URL']) config.osrmUrl = env['OSRM_URL'];
  return config;
}

export interface LoadedWorld {
  detectors: Detector[];
  engine: RoutingEngine;
  /** True when nothing real was configured and the demo city is standing in. */
  demoMode: boolean;
  description: string;
}

/**
 * Builds the world the server answers for.
 *
 * With nothing configured it runs the synthetic demo city, and says so on every
 * response. That is a deliberate choice over refusing to start: a developer
 * should be able to clone this and see it work, and a user should never be
 * shown fixture data without being told it is fixture data.
 */
export async function loadWorld(config: ServerConfig): Promise<LoadedWorld> {
  let detectors: Detector[] = [];
  let network: RoadNetworkGeoJson | null = null;
  let demoMode = false;
  const parts: string[] = [];

  if (config.datasetPath) {
    const raw = JSON.parse(
      await readFile(resolve(config.datasetPath), 'utf8'),
    ) as DetectorFeatureCollection;
    detectors = fromFeatureCollection(raw);
    parts.push(`${detectors.length} devices from ${config.datasetPath}`);
  }

  if (config.roadNetworkPath) {
    network = JSON.parse(await readFile(resolve(config.roadNetworkPath), 'utf8')) as RoadNetworkGeoJson;
    parts.push(`${network.features.length} road features from ${config.roadNetworkPath}`);
  }

  if (detectors.length === 0 && !network) {
    const demo = createDemoCity();
    detectors = demo.detectors;
    network = demo.network;
    demoMode = true;
    parts.push('synthetic demo city (no DATASET_PATH configured)');
  }

  let engine: RoutingEngine;
  switch (config.engine) {
    case 'valhalla':
      engine = new ValhallaEngine({ baseUrl: config.valhallaUrl! });
      break;
    case 'osrm':
      engine = new OsrmEngine({ baseUrl: config.osrmUrl! });
      break;
    default:
      if (!network) {
        throw new Error(
          'ROUTING_ENGINE=graph needs ROAD_NETWORK_PATH, or unset DATASET_PATH to use the demo city',
        );
      }
      engine = new GraphRoutingEngine(network, detectors);
  }
  parts.push(`engine: ${engine.label}`);

  return { detectors, engine, demoMode, description: parts.join('; ') };
}
