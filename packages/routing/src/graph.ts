import type { BBox, Detector, LatLon, RouteCandidate } from '@cam-nav/core';
import {
  DetectorIndex,
  boundsOf,
  captureProbability,
  bearingDeg,
  effectiveRangeM,
  haversineM,
  projectOnSegment,
  retentionMultiplier,
  DETECTOR_PROFILES,
} from '@cam-nav/core';
import { RoutingError } from './errors.js';
import type { RouteRequest, RoutingEngine } from './types.js';

/**
 * A road-network router that prices surveillance during the search itself.
 *
 * Everything else in this repo can re-rank routes an external engine happened
 * to produce, which only works when one of those routes is already the quiet
 * one. This router puts the exposure term inside the cost function, so it can
 * find a quiet path no alternates list would have offered — and it runs with no
 * network and no service to stand up, which is what makes the whole stack
 * testable and demonstrable offline.
 *
 * The search uses a linear surrogate for exposure. The real privacy model is
 * superlinear (repeat sightings by one operator compound), which is not
 * decomposable over edges, so the surrogate is a lower bound used for the
 * search and every candidate is then scored exactly by @cam-nav/core.
 */

export interface RoadFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  properties: Record<string, unknown>;
}

export interface RoadNetworkGeoJson {
  type: 'FeatureCollection';
  features: RoadFeature[];
}

/** Free-flow speeds in km/h when a way carries no maxspeed. */
const DEFAULT_SPEED_KPH: Readonly<Record<string, number>> = Object.freeze({
  motorway: 105,
  motorway_link: 60,
  trunk: 85,
  trunk_link: 55,
  primary: 60,
  primary_link: 45,
  secondary: 50,
  secondary_link: 40,
  tertiary: 40,
  tertiary_link: 35,
  unclassified: 35,
  residential: 30,
  living_street: 15,
  service: 20,
});

const DEFAULT_SPEED = 35;

export function parseMaxSpeedKph(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return text.includes('mph') ? value * 1.609_344 : value;
}

export function speedKphFor(properties: Record<string, unknown>): number {
  return (
    parseMaxSpeedKph(properties['maxspeed']) ??
    DEFAULT_SPEED_KPH[String(properties['highway'] ?? '')] ??
    DEFAULT_SPEED
  );
}

interface Edge {
  to: number;
  lengthM: number;
  travelS: number;
  /** Linear surveillance surrogate for this edge, in privacy units. */
  privacyUnits: number;
  /** Citation exposure attributable to this edge, 0..1. */
  citation: number;
  wayIndex: number;
  bearing: number;
}

const NODE_PRECISION = 1e6; // ~11 cm; enough to snap shared way endpoints

function nodeKey(p: LatLon): string {
  return `${Math.round(p.lat * NODE_PRECISION)}:${Math.round(p.lon * NODE_PRECISION)}`;
}

class MinHeap {
  private readonly items: Array<{ node: number; priority: number }> = [];

  push(node: number, priority: number): void {
    this.items.push({ node, priority });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.priority <= this.items[i]!.priority) break;
      [this.items[parent]!, this.items[i]!] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): { node: number; priority: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l]!.priority < this.items[smallest]!.priority) smallest = l;
        if (r < this.items.length && this.items[r]!.priority < this.items[smallest]!.priority) smallest = r;
        if (smallest === i) break;
        [this.items[smallest]!, this.items[i]!] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface GraphStats {
  nodes: number;
  edges: number;
  ways: number;
  /** Edges carrying a non-zero surveillance surrogate. */
  watchedEdges: number;
  /** Connected components; a bbox extract always has more than one. */
  components: number;
  largestComponentNodes: number;
}

export class RoadGraph {
  private readonly nodes: LatLon[] = [];
  private readonly nodeIds = new Map<string, number>();
  private readonly adjacency: Edge[][] = [];
  private maxSpeedKph = 1;
  private readonly component: Int32Array;
  /** Component id holding the most nodes — the real network in a bbox extract. */
  readonly largestComponent: number;
  readonly stats: GraphStats;

  constructor(network: RoadNetworkGeoJson, detectors: readonly Detector[] = []) {
    const index = new DetectorIndex(detectors);
    let wayIndex = 0;
    let edges = 0;
    let watchedEdges = 0;

    for (const feature of network.features) {
      if (feature.geometry?.type !== 'LineString') continue;
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;

      const properties = feature.properties ?? {};
      const speed = speedKphFor(properties);
      this.maxSpeedKph = Math.max(this.maxSpeedKph, speed);
      const oneway = String(properties['oneway'] ?? '').toLowerCase();
      const forwardOnly = oneway === 'yes' || oneway === 'true' || oneway === '1';
      const backwardOnly = oneway === '-1' || oneway === 'reverse';

      for (let i = 1; i < coords.length; i++) {
        const a: LatLon = { lon: coords[i - 1]![0], lat: coords[i - 1]![1] };
        const b: LatLon = { lon: coords[i]![0], lat: coords[i]![1] };
        const lengthM = haversineM(a, b);
        if (lengthM <= 0) continue;

        const ai = this.nodeIndex(a);
        const bi = this.nodeIndex(b);
        const travelS = lengthM / ((speed * 1000) / 3600);
        const forwardBearing = bearingDeg(a, b);

        const forwardExposure = this.exposureForSegment(a, b, index, forwardBearing);
        const backwardExposure = this.exposureForSegment(a, b, index, (forwardBearing + 180) % 360);
        if (forwardExposure.privacyUnits > 0) watchedEdges += 1;

        if (!backwardOnly) {
          this.adjacency[ai]!.push({ to: bi, lengthM, travelS, wayIndex, bearing: forwardBearing, ...forwardExposure });
          edges += 1;
        }
        if (!forwardOnly) {
          this.adjacency[bi]!.push({
            to: ai,
            lengthM,
            travelS,
            wayIndex,
            bearing: (forwardBearing + 180) % 360,
            ...backwardExposure,
          });
          edges += 1;
        }
      }
      wayIndex += 1;
    }

    this.component = this.computeComponents();
    let largest = 0;
    const sizes = new Map<number, number>();
    for (const c of this.component) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    for (const [id, size] of sizes) {
      if (size > (sizes.get(largest) ?? 0)) largest = id;
    }
    this.largestComponent = largest;

    this.stats = {
      nodes: this.nodes.length,
      edges,
      ways: wayIndex,
      watchedEdges,
      components: sizes.size,
      largestComponentNodes: sizes.get(largest) ?? 0,
    };
  }

  /**
   * Connected components over undirected adjacency.
   *
   * A road network extracted for a bounding box is never one component: ways
   * are cut at the box edge, leaving stubs joined to nothing, and interchanges
   * can leave ramp fragments stranded. Snapping an endpoint to whichever node
   * is nearest therefore lands on an island often enough to matter, and the
   * search then correctly reports no route between two points that are plainly
   * connected on a real map. Snapping within one component removes that whole
   * class of failure.
   *
   * Undirected on purpose: a node reachable only against a one-way is still
   * part of the network for the purpose of choosing where to start.
   */
  private computeComponents(): Int32Array {
    const n = this.nodes.length;
    const component = new Int32Array(n).fill(-1);
    const undirected: number[][] = Array.from({ length: n }, () => []);
    for (let from = 0; from < n; from++) {
      for (const edge of this.adjacency[from]!) {
        undirected[from]!.push(edge.to);
        undirected[edge.to]!.push(from);
      }
    }
    let next = 0;
    for (let seed = 0; seed < n; seed++) {
      if (component[seed] !== -1) continue;
      const id = next++;
      const stack = [seed];
      component[seed] = id;
      while (stack.length > 0) {
        const node = stack.pop()!;
        for (const neighbour of undirected[node]!) {
          if (component[neighbour] === -1) {
            component[neighbour] = id;
            stack.push(neighbour);
          }
        }
      }
    }
    return component;
  }

  private nodeIndex(p: LatLon): number {
    const key = nodeKey(p);
    const existing = this.nodeIds.get(key);
    if (existing != null) return existing;
    const id = this.nodes.length;
    this.nodes.push(p);
    this.nodeIds.set(key, id);
    this.adjacency.push([]);
    return id;
  }

  /**
   * Exposure attributable to traversing one segment in one direction.
   * A device is charged to the segment whose line passes closest to it, which
   * is decided at query time by taking the minimum over the segment.
   */
  private exposureForSegment(
    a: LatLon,
    b: LatLon,
    index: DetectorIndex,
    travelBearing: number,
  ): { privacyUnits: number; citation: number } {
    const nearby = index.queryCorridor([a, b], 200);
    let privacyUnits = 0;
    let noCitation = 1;
    for (const detector of nearby) {
      const distance = projectOnSegment(detector.position, a, b).distanceM;
      if (distance > effectiveRangeM(detector) * 2.5) continue;
      const p = captureProbability(detector, distance, travelBearing);
      if (p <= 0) continue;
      const profile = DETECTOR_PROFILES[detector.kind];
      privacyUnits += p * profile.privacyWeight * retentionMultiplier(profile.retentionDays);
      noCitation *= 1 - Math.min(1, p * profile.citationWeight);
    }
    return { privacyUnits, citation: 1 - noCitation };
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  positionOf(node: number): LatLon {
    return this.nodes[node]!;
  }

  bounds(): BBox {
    return boundsOf(this.nodes);
  }

  /**
   * Nearest graph node to a position, within `maxSnapM`.
   *
   * `component` restricts the search to one connected component, which is how
   * both ends of a trip are kept on the same network rather than on an island
   * left behind by the bbox cut.
   */
  nearestNode(target: LatLon, maxSnapM = 500, component?: number): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      if (component !== undefined && this.component[i] !== component) continue;
      const d = haversineM(this.nodes[i]!, target);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return bestDistance <= maxSnapM ? best : null;
  }

  componentOf(node: number): number {
    return this.component[node] ?? -1;
  }

  /**
   * A* over travel time plus a priced surveillance term.
   *
   * `lambdaSPerUnit` is seconds of travel the search will pay to avoid one
   * privacy unit. `edgePenalty` lets alternative generation charge extra for
   * edges already used, which is how the plateau method produces routes that
   * are genuinely different rather than one route with a wiggle in it.
   */
  search(
    startNode: number,
    goalNode: number,
    lambdaSPerUnit: number,
    citationLambdaS = 0,
    edgePenalty?: (fromNode: number, edge: Edge) => number,
  ): { path: number[]; travelS: number; distanceM: number } | null {
    const n = this.nodes.length;
    const best = new Float64Array(n).fill(Infinity);
    const cameFrom = new Int32Array(n).fill(-1);
    const travel = new Float64Array(n).fill(Infinity);
    const distance = new Float64Array(n).fill(Infinity);
    const settled = new Uint8Array(n);

    const goal = this.nodes[goalNode]!;
    const metresPerSecond = (this.maxSpeedKph * 1000) / 3600;
    // Admissible: no edge can be traversed faster than the network's top speed,
    // and the surveillance term only ever adds cost.
    const heuristic = (node: number): number => haversineM(this.nodes[node]!, goal) / metresPerSecond;

    best[startNode] = 0;
    travel[startNode] = 0;
    distance[startNode] = 0;
    const queue = new MinHeap();
    queue.push(startNode, heuristic(startNode));

    while (queue.size > 0) {
      const current = queue.pop()!;
      const node = current.node;
      if (settled[node]) continue;
      settled[node] = 1;
      if (node === goalNode) break;

      for (const edge of this.adjacency[node]!) {
        const penalty = edgePenalty ? edgePenalty(node, edge) : 0;
        const cost =
          edge.travelS +
          lambdaSPerUnit * edge.privacyUnits +
          citationLambdaS * edge.citation +
          penalty;
        const candidate = best[node]! + cost;
        if (candidate < best[edge.to]!) {
          best[edge.to] = candidate;
          travel[edge.to] = travel[node]! + edge.travelS;
          distance[edge.to] = distance[node]! + edge.lengthM;
          cameFrom[edge.to] = node;
          queue.push(edge.to, candidate + heuristic(edge.to));
        }
      }
    }

    if (!Number.isFinite(best[goalNode]!)) return null;

    const path: number[] = [];
    for (let node = goalNode; node !== -1; node = cameFrom[node]!) {
      path.push(node);
      if (node === startNode) break;
    }
    path.reverse();
    if (path[0] !== startNode) return null;

    return { path, travelS: travel[goalNode]!, distanceM: distance[goalNode]! };
  }

  geometryOf(path: readonly number[]): LatLon[] {
    return path.map((node) => this.nodes[node]!);
  }
}

export interface GraphEngineOptions {
  /**
   * Lambda values, in seconds per privacy unit, used to sweep the search from
   * "fastest" to "quietest". Each distinct route found becomes a candidate.
   */
  lambdaSweepSPerUnit?: number[];
  /** Extra seconds charged per already-used edge when diversifying. */
  plateauPenaltyS?: number;
  maxSnapM?: number;
}

/**
 * The offline engine. Give it a road network and the detector set and it
 * produces the whole time-versus-exposure frontier in one pass.
 */
export class GraphRoutingEngine implements RoutingEngine {
  readonly id = 'graph';
  readonly label = 'Built-in surveillance-aware router';
  readonly supportsAvoidAreas = false;
  readonly supportsCustomCosting = true;

  private readonly graph: RoadGraph;
  private readonly options: Required<GraphEngineOptions>;

  constructor(network: RoadNetworkGeoJson, detectors: readonly Detector[], options: GraphEngineOptions = {}) {
    this.graph = new RoadGraph(network, detectors);
    this.options = {
      // Spread over three orders of magnitude: 0 is pure time, 1800 s/unit is
      // half an hour of driving to dodge one plate read.
      lambdaSweepSPerUnit: options.lambdaSweepSPerUnit ?? [0, 8, 20, 45, 100, 250, 700, 1800],
      plateauPenaltyS: options.plateauPenaltyS ?? 0,
      maxSnapM: options.maxSnapM ?? 500,
    };
  }

  get stats(): GraphStats {
    return this.graph.stats;
  }

  coverage(): BBox | null {
    return this.graph.nodeCount > 0 ? this.graph.bounds() : null;
  }

  async route(request: RouteRequest): Promise<RouteCandidate[]> {
    // Both ends are snapped into the largest connected component. In a network
    // extracted for a bounding box that component is the real road system, and
    // the rest are stubs the box cut loose; snapping to whichever node happens
    // to be nearest strands trips on those and reports no route between points
    // that are obviously connected.
    const component = this.graph.largestComponent;
    const start = this.graph.nearestNode(request.from, this.options.maxSnapM, component);
    const goal = this.graph.nearestNode(request.to, this.options.maxSnapM, component);
    if (start == null || goal == null) {
      throw new RoutingError(
        'out_of_coverage',
        'origin or destination is outside the loaded road network',
      );
    }
    if (start === goal) {
      throw new RoutingError('degenerate', 'origin and destination snap to the same point');
    }

    const seen = new Set<string>();
    const candidates: RouteCandidate[] = [];

    for (const lambda of this.options.lambdaSweepSPerUnit) {
      const result = this.graph.search(start, goal, lambda, lambda * 0.5);
      if (!result) continue;
      const signature = result.path.join(',');
      if (seen.has(signature)) continue;
      seen.add(signature);
      candidates.push({
        id: `graph-l${lambda}`,
        geometry: this.graph.geometryOf(result.path),
        distanceM: Math.round(result.distanceM),
        durationS: Math.round(result.travelS),
        origin: candidates.length === 0 ? 'engine_primary' : 'penalty_iteration',
        label: lambda === 0 ? 'Fastest' : `Surveillance-weighted (${lambda}s/unit)`,
      });
    }

    if (candidates.length === 0) {
      throw new RoutingError('no_route', 'no route found between those points');
    }
    return candidates;
  }
}
