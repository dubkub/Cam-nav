# Data sources and reliability

The routing is only as good as the map behind it, so this package is organised
around *how much a record deserves to be believed* rather than around fetching
points.

## Sources

### OpenStreetMap (primary)

The only surveillance inventory that is global, openly licensed, and
correctable by the people who live next to the cameras. Pulled via Overpass.

Tag schemes covered, roughly in order of how much they are used in practice:

| What | Tags |
| --- | --- |
| Plate readers | `man_made=surveillance` + `surveillance:type=ALPR` (or `ANPR`) |
| Traffic-zone cameras | `man_made=surveillance` + `surveillance:zone=traffic` |
| Speed cameras | `highway=speed_camera`, or `enforcement=maxspeed` |
| Average-speed sections | `type=enforcement` + `enforcement=average_speed` |
| Red-light cameras | `type=enforcement` + `enforcement=traffic_signals` |
| Bus lane | `enforcement=bus_lane` |
| Tolling | `barrier=toll_booth`, `highway=toll_gantry`, `enforcement=toll` |
| Public CCTV | `man_made=surveillance` + `surveillance:type=camera` |

Aim comes from `camera:direction`, `direction` or `surveillance:direction`, any
of which may be degrees, a compass point, or a range like `90-140`. Values that
cannot be read (`forward`, `backward` — meaningless without a way) are left
unset rather than guessed, and an unset aim is scored conservatively.

Two details that matter more than they look:

- **`out meta` is required, not cosmetic.** The element timestamp is the last
  time a human touched the record, and the entire recency model rests on it.
- **Enforcement relations are expanded first.** A device node in an
  average-speed relation often carries no tags of its own; the relation is the
  evidence for what it is. Sections emit both ends, cross-referenced, rather
  than collapsing to one point.

Overpass is volunteer infrastructure. The client retries with backoff, rotates
mirrors, and identifies itself. Run ingestion on a schedule into a cache —
never once per user request.

### DeFlock

The largest community plate-reader mapping effort. Its submissions are
contributed upstream to OpenStreetMap, which is where this pipeline picks them
up, so the direct adapter is **off by default**: ingesting both would
double-count the same observation and inflate confidence. The preset exists for
anyone who wants the direct feed and has confirmed the endpoint.

### Agency open data

Cities and transport authorities often publish their own camera lists. These
are the highest-trust source available, and they are also the ones that go
stale quietly. Rather than a bespoke client per city, feeds are declared as
data — a URL, a format, and a field mapping — so adding one is a JSON file, not
code:

```json
{
  "id": "example_city",
  "sourceId": "agency",
  "url": "https://data.example.gov/red-light-cameras.csv",
  "format": "csv",
  "mapping": {
    "lat": "latitude", "lon": "longitude", "id": "camera_id",
    "operator": "agency", "direction": "facing",
    "lastVerified": "last_audit", "defaultKind": "red_light_camera"
  },
  "attribution": "City of Example",
  "license": "CC0-1.0"
}
```

```bash
pnpm ingest --bbox=… --feeds=feeds.json
```

### Community reports

Users see cameras before the datasets catch up, so reports are worth having.
They are also a single anonymous pin, and are scored accordingly: one report
never carries enough confidence to force a long detour.

Reporter identity is stored as a **salted hash and nothing else**. A tool whose
point is not being tracked has no business keeping a list of who was where. The
hash exists for exactly one purpose — telling corroboration apart from one
person filing twice.

## The confidence model

Confidence is the probability that a device is really there, aimed as
described, and working. It is derived, never hand-set, and feeds straight into
capture probability — so a stale rumour costs a user seconds of detour while a
fresh municipal record costs minutes.

### Per record

```
confidence = baseTrust(source) × recency(age, halfLife)
recency    = 0.35 + 0.65 × exp(−ln2 × ageDays / halfLifeDays)
```

| Source | Base trust | Half-life |
| --- | --- | --- |
| Agency disclosure | 0.95 | 900 days |
| OpenStreetMap | 0.85 | 540 days |
| DeFlock | 0.85 | 540 days |
| Community report | 0.40 | 150 days |

Recency decays toward a floor rather than to zero: an old record is weak
evidence, not no evidence. An undated record is treated as a year old rather
than as fresh.

### Combining sources

Independent agreement raises confidence; repetition does not. Sources are
grouped by independence, and the groups combine as noisy-OR:

```
confidence = 1 − Π over groups ( 1 − groupConfidence )
```

- **`osm_ecosystem`** (OSM, DeFlock) — takes the *best* record, not the
  combination. DeFlock submissions flow into OSM, so seeing a camera in both is
  one observation wearing two hats.
- **`official`** (agency) — independent of the community mapping effort, so it
  genuinely corroborates.
- **`community`** (reports) — distinct reporters corroborate each other; one
  reporter filing twice does not.

Nothing reaches certainty — the ceiling is 0.97. Somebody can always have taken
the pole down this morning.

A small completeness discount applies to records with neither aim nor operator:
usually a drive-by pin rather than a surveyed device, kept in the dataset but
not permitted to buy a long detour on its own.

## Merging across sources

Records within 25 m may describe the same device, subject to two checks:

- **Kind compatibility.** A generic "camera" record merges into a specific
  plate-reader record and the specific kind wins. A red-light camera and a
  speed camera never merge, even co-located.
- **Aim conflict.** If both state an aim and they differ by more than 70°, they
  are different devices. Cameras on opposite approaches of one junction sit
  metres apart and must survive as separate records.

Merged records average position, union provenance, and take each missing field
from whichever source had it.

## Build output and drift

Every build writes:

- `detectors.geojson` — the dataset, provenance included per record.
- `manifest.json` — counts by kind and source, a confidence histogram,
  attributions, licences, and **per-source failures**. A partial build says so
  out loud.
- `diff.json` — added, removed, moved and confidence-changed against the
  previous build.

The CLI exits non-zero when a build drops more than a fifth of the previous
devices. At that scale it is a broken query or a failing upstream far more
often than it is real removals, and a dataset that routes people should not
change silently.

## Licensing and attribution

| Source | Licence | Obligation |
| --- | --- | --- |
| OpenStreetMap | ODbL-1.0 | `© OpenStreetMap contributors`; derived datasets stay ODbL |
| DeFlock | ODbL-1.0 | as above |
| Agency data | varies | per feed; recorded in the feed definition |
| Community reports | CC0-1.0 | none |

Attribution is carried on every record through merging, and served at
`/v1/meta`, so a client cannot lose it by accident.

## Improving coverage

Coverage is the dominant error in the whole system and it is not a modelling
problem. If a device is missing or wrong, the fix belongs in OpenStreetMap,
where every downstream user gets it — which is why each device in the app links
back to its upstream record rather than offering a private correction only you
would see.
