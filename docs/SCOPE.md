# Scope

## What this is for

Deciding, with real numbers, how much extra travel time is worth how much less
of a record that you drove somewhere. That decision is currently made blind —
you cannot see the cameras on a route before you take it, so you cannot trade
against them. This makes the trade visible and lets you set the rate.

Routing around a plate reader is ordinary lawful behaviour. So is choosing a
different street.

## What this is not for

**Evading enforcement.** Every route this produces is an ordinary legal route,
and every road on it has the same rules as the one you were on. Avoiding a
speed camera is not a licence to speed. The app will not help anyone evade an
active investigation or a pursuit, and it is not built to: it knows only about
fixed, publicly mapped installations, it has no live information about
anything, and it cannot see where anyone is looking now.

**A guarantee.** It can only avoid what somebody has mapped. Coverage is good
in some cities and nearly absent in others, and a route with nothing on it is
less watched, not unwatched. The app says this on the map screen, in the route
explanation and at `/v1/meta`, because a tool that tells people where they are
watched becomes a tool that tells people they are safe the moment it stops
mentioning its own blind spots.

**Anonymity.** It addresses one channel — fixed roadside plate capture — and
does nothing about the rest. A phone with location services on, a car with
connected services, a toll transponder and a card used at the destination all
report the trip regardless of which street you drove down. Treating this app as
anonymity would be a worse outcome than not using it, because it would be
confidence without cover.

## Known limits, in order of how much they matter

1. **Coverage.** The dominant error. Not a modelling problem — a mapping one.
2. **Mobile and covert deployments.** Not in any public dataset, not modelled.
3. **Staleness.** Records age. Each device shows when it was last confirmed so
   you can judge it; that is the honest answer, not a fix.
4. **Aim data.** Frequently missing upstream; missing aim is scored as covering
   every approach, which over-states exposure for some devices.
5. **Retention and sharing.** Defaults are typical published values, not any
   particular agency's policy.

## If a record is wrong

Fix it in OpenStreetMap, where everyone downstream gets the correction. Each
device in the app links to its upstream record for exactly this reason: a
private correction that only you can see helps nobody else on that street.
