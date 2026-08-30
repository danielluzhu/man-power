# Man Power

Carrier-pigeon messaging, except the courier is the fastest human alive.

Send a message and it does not appear in the recipient's inbox until enough real
time has passed for a world-record athlete to have physically covered the
distance between you — running every landmass, swimming every sea. New York to
London takes about **31 days**. There is no way to hurry it.

**→ [Time a journey yourself](https://danielluzhu.github.io/man-power/)** — the
project site runs the real routing engine in your browser, no server involved.

![the courier, mid-Atlantic](docs/screenshot.png)

---

## The idea

A carrier pigeon flies at roughly 80 km/h. A human does not. This app takes that
premise seriously and asks what messaging would feel like if the fastest person
who has ever lived had to carry every message by hand.

So a message is not transmitted. It is **carried**. The server computes the
great-circle route between sender and recipient, splits it into legs of land and
water, times each leg against the world record for that distance and surface,
and seals the message until the sum of those legs has elapsed. Until then the
recipient can watch the courier's position on a globe and see how far they have
left — but the body of the message is not on their machine at all.

## The pace model

Records are applied as **pace**, not as a flat duration. A 400 m hop does not
take Josh Kerr's full 3:42.66; it takes 400 m *at* his mile pace. This is the
only reading that stays coherent at the long end, where the marathon record has
to cover journeys of thousands of kilometres.

**On land — running.** The ladder runs from the mile to the marathon:

| Distance | Time | Held by |
|---|---|---|
| 1 mile | 3:42.66 | Josh Kerr (GBR) |
| 2000 m | 4:43.13 | Hicham El Guerrouj (MAR) |
| 3000 m | 7:17.55 | Daniel Komen (KEN) |
| 5000 m | 12:35.36 | Joshua Cheptegei (UGA) |
| 10,000 m | 26:11.00 | Joshua Cheptegei (UGA) |
| 15 km | 40:16 | Jacob Kiplimo (UGA) |
| half marathon | 56:42 | Jacob Kiplimo (UGA) |
| 25 km | 1:10:30 | Dennis Kimetto (KEN) |
| marathon | 1:59:30 | Sabastian Sawe (KEN) |

Anything shorter than a mile holds Kerr's mile pace. Anything past 26.2 miles
holds Sawe's marathon pace, however far it goes — which is what makes a
transcontinental leg tractable at all.

**On water — swimming.** Long-course freestyle world records, 50 m through
1500 m (César Cielo, Pan Zhanle, Paul Biedermann, Lukas Märtens, Zhang Lin, Sun
Yang). Beyond 1500 m — the longest distance with a standing record — pace holds
at Sun Yang's, whatever the width of the ocean.

**Between the records**, pace is interpolated linearly in log(distance) vs
log(time) space — the standard endurance-curve relationship. The curve passes
exactly through every record above and bends smoothly between them.

### A note on three omitted records

The 2 mile, 10 mile and 30 km bests are all *slower in pace terms* than their
neighbours on the ladder (a sub-two-hour marathon outpaces the standing 30 km
best, for instance). Including them would make the curve non-monotonic, meaning
a longer journey could be delivered sooner than a shorter one along the same
route. They are left off, and `assertMonotonic()` fails at import time if the
ladder ever stops being strictly decreasing in speed.

## How a route is built

1. Sample the great circle between the two points every 0.5–10 km.
2. Classify each sample against a land/water bitmap rasterized from Natural
   Earth 1:50m coastlines at 0.1° (3600 × 1800, 791 KB).
3. Group consecutive same-surface samples into legs, bisecting each surface
   change down to ~50 m so crossings land on the actual coast.
4. Time each leg independently against its own record and sum.

Because legs are timed independently, a 600 m river crossing is swum at 800 m
pace while the 4000 km either side of it is run at marathon pace. The app shows
you the full itinerary, leg by leg, with the record governing each one.

Endpoints are always treated as land — cities are on land, but a coastal one can
fall in a water cell at this resolution.

## The globe

The client draws its own orthographic globe on a canvas, with no tile server
involved. A flat projection would bend the Atlantic crossing into what looks
like a detour and tear any antimeridian route in half; on a sphere a great
circle is simply the shortest visible arc.

Coastline rings that straddle the limb are clipped with Sutherland-Hodgman in
3D against the view plane, then stitched back along the horizon circle between
successive exit and entry points. (Without that arc the clip closes continents
off with a straight chord, and Africa grows a flat edge.)

## The project site

<https://danielluzhu.github.io/man-power/>

Published from `docs/` on `main`. It is not a brochure: it runs the *actual*
routing engine client-side — the same ladder, the same coastline bitmap, the
same leg splitting — so you can time any pair of cities without installing
anything. The land mask is 47 KB gzipped, which makes that practical.

`scripts/build-site.js` copies the real modules into `docs/lib/` on every build
rather than keeping a parallel copy, so the site cannot drift from the app:

```bash
bun run build:site
```

## Running it

```bash
bun install
bun run server.js          # http://localhost:4321
```

The compiled datasets are committed, so it runs out of the box. To rebuild them
from upstream sources:

```bash
bun run build:data         # land mask, gazetteer, world outline, site assets
```

You need **at least two couriers** for anything to happen — enlist a second one
in a private window and write to yourself the long way round.

### As a systemd service

```bash
sudo deploy/install.sh
```

Installs `deploy/man-power.service`, enables it for boot and waits for the port
to actually answer before reporting success — printing the journal if it does
not. The service runs as `ubuntu`, restarts on failure, and gives up only after
five failures in a minute so a genuine crash loop surfaces rather than being
restarted forever.

It is sandboxed with `ProtectSystem=strict`: the app reads its datasets and
writes exactly one SQLite database, so `/workspace/data` is the only writable
path it has.

```bash
systemctl status man-power         # is it up?
journalctl -u man-power -f         # follow the log
sudo systemctl restart man-power   # after a code change
```

### Tests

```bash
bun test                   # pace model and routing invariants
bun run test:browser       # drives the real app in headless Chromium
```

The browser test exists because the worst bugs here were invisible to unit
tests: a CSS rule that silently defeated the `[hidden]` attribute and rendered
two screens on top of each other, an invalid `pattern` attribute, and a city
search that could not find "Zürich" if you typed "Zurich".

## Layout

```
server.js              HTTP server and JSON API
src/records.js         world-record ladders and the pace curve
src/geo.js             great-circle routing, land/water leg splitting
src/sphere.js          pure great-circle math, shared with the browser
src/db.js              SQLite storage
public/globe.js        orthographic globe renderer
public/app.js          client application
docs/                  the published project site (GitHub Pages)
deploy/                systemd unit and installer
scripts/build-*.js     compile the datasets and the site
```

`src/sphere.js` is served to the browser at `/sphere.js` so the dot on the globe
and the clock beside it are computed by the same code that set the arrival time.

## Data

- Coastlines: [Natural Earth](https://www.naturalearthdata.com/) 1:50m and
  1:110m land polygons (public domain).
- Cities: [GeoNames](https://www.geonames.org/) `cities15000` — 34,125 cities
  over 15,000 people (CC BY 4.0).

## Caveats, cheerfully admitted

The courier runs great circles, so they run straight over the Himalayas and
through the Darién Gap without slowing down. They do not sleep, eat, or wait for
weather. Ocean currents do not exist. And they hold marathon world-record pace
for six thousand kilometres, which is the whole joke.
