import type { BBox, Detector } from '@cam-nav/core';

export interface FetchResult {
  detectors: Detector[];
  /** Anything the adapter wants surfaced in the build manifest. */
  notes: string[];
  /** Attribution text that must travel with the data. */
  attribution: string;
  license: string;
}

export interface SourceAdapter {
  id: string;
  label: string;
  /** Pulls every device this source knows about inside `area`. */
  fetch(area: BBox, signal?: AbortSignal): Promise<FetchResult>;
}
