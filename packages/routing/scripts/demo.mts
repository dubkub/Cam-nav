import { DetectorIndex, rankRoutes, sliderBreakpoints, explainSelection } from '@cam-nav/core';
import { GraphRoutingEngine, createDemoCity } from '../src/index.js';

const city = createDemoCity();
const engine = new GraphRoutingEngine(city.network, city.detectors);
const index = new DetectorIndex(city.detectors);
const routes = await engine.route({ from: city.origin, to: city.destination });

console.log(`graph: ${JSON.stringify(engine.stats)}`);
console.log(`\n${routes.length} candidates:`);
for (const r of routes) {
  console.log(`  ${r.id.padEnd(16)} ${(r.durationS / 60).toFixed(1)} min  ${(r.distanceM / 1000).toFixed(2)} km`);
}

console.log('\nslider breakpoints:');
for (const b of sliderBreakpoints(routes, index)) {
  console.log(`  bias >= ${b.bias.toFixed(2)}  ->  ${b.routeId.padEnd(16)} ${(b.durationS / 60).toFixed(1)} min, ${b.expectedCaptures.toFixed(2)} expected captures, ${b.privacyUnits.toFixed(2)} privacy units`);
}

for (const bias of [0, 0.35, 0.7, 1]) {
  const ranked = rankRoutes(routes, index, bias);
  const out = explainSelection(ranked);
  console.log(`\n--- bias ${bias} ---`);
  console.log(`  ${out.summary}`);
  console.log(`  ${out.selected.headline}`);
  for (const d of out.selected.detail) console.log(`    · ${d}`);
}
