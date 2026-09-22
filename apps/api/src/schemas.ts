import { z } from 'zod';

const latitude = z.number().gte(-90).lte(90);
const longitude = z.number().gte(-180).lte(180);

export const pointSchema = z.object({ lat: latitude, lon: longitude });

export const detectorKindSchema = z.enum([
  'alpr',
  'mobile_alpr',
  'speed_camera',
  'average_speed_camera',
  'red_light_camera',
  'bus_lane_camera',
  'toll_gantry',
  'congestion_charge',
  'traffic_camera',
  'cctv',
]);

export const routeRequestSchema = z.object({
  from: pointSchema,
  to: pointSchema,
  via: z.array(pointSchema).max(8).optional(),
  /** 0 = fastest, 1 = least watched. */
  privacyBias: z.number().gte(0).lte(1).default(0.5),
  vehicle: z.enum(['car', 'motorcycle', 'truck', 'bicycle']).default('car'),
  departAt: z.string().datetime().optional(),
  /** Device kinds the user does not want routed around. */
  ignoreKinds: z.array(detectorKindSchema).max(12).default([]),
  /** Drop records below this confidence before routing. */
  minConfidence: z.number().gte(0).lte(1).default(0.15),
  /** Include full per-device detail in the response. Larger payload. */
  includeEncounters: z.boolean().default(true),
});

export type RouteRequestBody = z.infer<typeof routeRequestSchema>;

export const bboxSchema = z
  .string()
  .transform((raw, ctx) => {
    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be minLat,minLon,maxLat,maxLon' });
      return z.NEVER;
    }
    const [minLat, minLon, maxLat, maxLon] = parts as [number, number, number, number];
    if (minLat >= maxLat || minLon >= maxLon) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox min must be below max' });
      return z.NEVER;
    }
    // A bbox big enough to cover a continent is a scrape, not a map view.
    if (maxLat - minLat > 2 || maxLon - minLon > 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox may not exceed 2 degrees on a side' });
      return z.NEVER;
    }
    return { minLat, minLon, maxLat, maxLon };
  });

export const detectorQuerySchema = z.object({
  bbox: bboxSchema,
  kinds: z
    .string()
    .optional()
    .transform((raw) => (raw ? raw.split(',').map((k) => k.trim()) : undefined)),
  minConfidence: z.coerce.number().gte(0).lte(1).default(0.15),
  limit: z.coerce.number().int().positive().max(5000).default(2000),
});

export const reportSchema = z.object({
  kind: detectorKindSchema,
  lat: latitude,
  lon: longitude,
  directionDeg: z.number().gte(0).lt(360).optional(),
  operator: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  /**
   * A per-installation identifier, hashed with a server salt before storage.
   * It exists only to tell corroboration apart from one person filing twice.
   */
  installationId: z.string().min(8).max(200),
});
