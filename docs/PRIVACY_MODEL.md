# The privacy model

How a route is turned into a number, and how that number is traded against
time. Everything here lives in `packages/core` and is unit tested; this
document explains the reasoning behind the code rather than restating it.

## 1. What is being measured

Two different things, kept apart because they are different costs to a driver:

- **Privacy exposure** — records created of the fact that you drove here, at
  this time. Plate readers create one for every vehicle. This is what the
  slider trades against time.
- **Citation exposure** — the chance of passing a device whose job is issuing
  penalties. Enforcement cameras normally produce nothing unless a threshold is
  crossed, so this is about not collecting an inadvertent ticket, not about
  evading enforcement. It is priced at a constant, moderate rate at *every*
  slider position, because nobody wants a surprise citation, including the
  person who chose "fastest".

Device types carry a weight on each axis, plus a typical retention period, in
`DETECTOR_PROFILES`. Where published behaviour varies by vendor or
jurisdiction, the default assumes the more capturing configuration: a user who
is under-warned loses privacy they cannot get back, while one who is
over-warned loses a few minutes.

## 2. Will this device actually record me?

For each device near the route:

```
p_capture = confidence × distanceFactor × directionFactor
```

**confidence** — how much the record is to be believed. Derived, never
hand-set; see [`DATA_SOURCES.md`](DATA_SOURCES.md).

**distanceFactor** — from the closest approach between the device and the route
*line*, computed by projecting onto each segment rather than measuring to the
nearest vertex. Route geometry can put vertices a hundred metres apart on a
straight road, and vertex distance would miss a camera at the midpoint
entirely. The factor is 1 inside 60% of the device's stated range and tapers
smoothly to 0 at 160%: sources quote a nominal range, but real capture degrades
with lane offset, weather and plate angle rather than stopping at a line.

**directionFactor** — a unit aimed down a carriageway reads traffic on that
axis, so the travel bearing is compared to the camera axis modulo 180°, not to
a single direction. Inside the field of view the factor is 1, and it tapers to
a small residual outside — never to zero, because aim data upstream is often
approximate. **A device with no recorded aim is treated as covering every
approach.** Most mapped devices have no aim, and assuming a camera cannot see
you is the error that costs a user the thing they came here for.

## 3. From captures to a privacy figure

A plain sum of capture probabilities would say that four sightings by one
operator and one sighting each by four operators are the same trip. They are
not. The first reconstructs where you went, in what direction, at what time.
The second is four disconnected dots.

So devices are bucketed by **data-sharing group** before summing:

```
n_eff  = (Σ u)² / Σ(u²)                    per group, u = p × weight × retention
linked = (Σ u) × n_eff ^ (1.35 − 1)        multiplier is never below 1
privacyUnits = Σ over groups  linked
```

The exponent applies to the group's **effective sighting count**, not to the sum
of its exposures. An earlier version raised the sum itself to the power, which
looks equivalent and is not: a sum only grows under a power above 1, and real
per-device capture probabilities are well below 1. Measured against Atlanta, a
three-camera group summing to 1.01 gained 0.4%, and groups totalling under 1
were silently *discounted* for being unlikely to see you. The term meant to be
the model's centrepiece was doing nothing.

`n_eff` is the inverse participation ratio: k equally likely sightings count as
k, one sighting counts as 1, and a near-certain reading plus a few faint ones
counts as barely more than one. It is the honest denominator — three cameras
that probably miss you are not three sightings.

The grouping is the important part. A camera run by a small police department
but built on a vendor platform that offers cross-agency lookups belongs to that
platform's group, not to the department — the practical observer is the network.
`packages/data/src/operators.ts` holds the mapping, keyed on documented
cross-agency search features of each platform, not on any assertion about a
particular agency's policy.

`retention` scales with the logarithm of how long a record stays queryable. A
plate read held for seven years is worth more than one dropped in a week, but
not ninety times more.

Citation exposure combines as "at least one", never as a sum:

```
citationExposure = 1 − Π (1 − p × citationWeight)
```

Three red-light cameras are not three times the risk of one.

## 4. The slider

The control produces one number, `bias ∈ [0, 1]`. It drives two mechanisms,
because either alone behaves badly.

**A marginal rate**, in minutes per privacy unit:

```
privacyLambdaMin = 12 × bias^1.6
```

At `bias = 1` the router will spend twelve minutes to avoid roughly one
avoidable plate read by a typical operator. The exponent keeps the low end of
the slider gentle, so small movements near "fastest" do not suddenly reroute
the trip.

**A hard detour budget**, because a rate alone will happily accept an
absurd detour when exposure is high enough:

```
detourBudget = (fastest × 1.0 + 45 min) × bias^1.6
```

A route is eligible only if it fits the budget; among the eligible ones, the
lowest total cost wins:

```
cost = minutes + privacyLambdaMin × privacyUnits + 6 × citationExposure
```

The fastest route is always eligible, whatever the budget rounds to.

### Why the slider has ticks

A continuous control implies a continuum of answers. A trip has a handful of
sensible routes, and between two breakpoints the slider changes nothing at all.
`sliderBreakpoints()` walks the range and reports the positions where the
recommendation actually changes; the app draws those on the track and snaps to
one when the handle lands near it. The control then tells the truth about how
much choice exists.

Candidates that are beaten on both time and exposure by another candidate are
dropped first (`paretoFrontier`): they can never be the right answer at any
slider position.

### Two properties worth guaranteeing

Both are asserted in the tests, because a slider that violates either is worse
than no slider:

- Moving the slider up never returns a **more** exposed route.
- Moving it down never returns a **slower** one.

## 5. Searching, not just re-ranking

Re-ranking an engine's alternatives only finds a quiet route when one happens
to be in the list. Two things are done about that:

- Where the engine supports exclusions (Valhalla), the devices contributing
  most exposure on the fastest route are excluded and the engine is asked
  again, with a wider exclusion each round.
- The built-in graph router puts the exposure term inside the cost function and
  sweeps λ from 0 to 1800 s/unit, producing the whole frontier in one pass.

The in-search term is a **linear** surrogate: the real model is superlinear and
does not decompose over edges. It is a lower bound used to steer the search,
and every candidate it returns is then scored exactly.

## 6. What the model does not capture

- Devices nobody has mapped. This is the dominant error term, and no amount of
  modelling fixes it.
- Mobile and covert deployments.
- Time-of-day behaviour: some enforcement only operates at certain hours. The
  travel context is plumbed through but not yet used.
- Whether a plate read is actually retained, queried or shared in practice.
  Retention defaults are typical values, not per-agency policy.
- Everything you carry. A phone with location services on reports your
  movements whichever street you drive down.
