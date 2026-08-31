# Man Power

Carrier-pigeon messaging, except the courier is the fastest human alive.

Send a message and it does not appear in the recipient's inbox until enough real
time has passed for a world-record athlete to have physically covered the
distance between you — running every landmass, swimming every sea, over real
terrain, by the fastest route they could take. New York to London takes about
**23 days**, and the courier goes by way of Greenland. There is no way to hurry
it.

**→ [Time a journey yourself](https://danielluzhu.github.io/man-power/)** — the
project site runs the real routing engine in your browser, no server involved.

![New York to London by way of Greenland — 23 days, 11 hours, across 33 legs, on a topographic globe](docs/screenshot.png)

---

## The idea

A carrier pigeon flies at roughly 80 km/h. A human does not. This app takes that
premise seriously and asks what messaging would feel like if the fastest person
who has ever lived had to carry every message by hand.

So a message is not transmitted. It is **carried**. The server searches for the
fastest way across the world between sender and recipient — over mountains,
around them, along coastlines, across straits — splits that path into legs of
land and water, times each leg against the world record for its distance and
surface with terrain applied along the way, and seals the message until the sum
of those legs has elapsed. Until then the recipient can watch the courier's
position on a globe and see how far they have left, but the body of the message
is not on their machine at all.

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

## The route the courier takes

Not the shortest path — the **soonest**. A least-time search over a grid of the
world, where each step costs whatever it costs to cross.

That single objective produces every behaviour worth having, none of it
special-cased:

| Route | What it does | Result |
|---|---|---|
| Madrid → Casablanca | crosses at Gibraltar instead of swimming wide | 328 km of swimming becomes 26 km; **41% faster** |
| New York → London | hops Baffin Island, Greenland and Iceland | no open-water leg over 844 km; **25% faster** |
| Lima → New York | hugs the Americas rather than cutting the Caribbean | **36% faster** |
| Delhi → Beijing | rounds the Himalaya through the Tarim Basin | 6,000 m less climbing |
| New York → Los Angeles | nothing worth going around | the straight line, unchanged |

Swimming is 3.4× slower than running, so a route will go hundreds of kilometres
out of its way to find a narrow crossing. Climbing costs time and thin air costs
more, so it prefers to go around a range than over it.

### How it works

1. **Plan** on a 0.2° grid (1800 × 900 cells) with A*, where every step is
   priced in seconds — flat ground, a mountainside, or open water.
2. **Measure** the chosen path against the original 0.1° mask and elevation
   data, so the search stays cheap but the reported numbers keep their
   resolution. Coast crossings are bisected to ~50 m.
3. **Time** each leg against the world record for *its* distance, with gradient
   and altitude applied segment by segment along it.

Because legs are timed independently, a 600 m river crossing is swum at 800 m
pace while the 4000 km either side is run at marathon pace. The app shows the
full itinerary leg by leg, with the record governing each one and the climbing
it involves.

Three details make the search work:

- **The heuristic.** Plain A* is hopeless here — a straight-line heuristic
  divided by top speed underestimates ocean crossings fourfold, so it fans out
  across an entire ocean before committing. The heuristic instead comes from a
  full Dijkstra run backwards from the destination over a 1° grid (64,800 cells,
  a few milliseconds), built optimistically so it stays admissible. It knows
  where the land bridges are.
- **Sixteen neighbours, not eight.** Eight restricts travel to multiples of 45°,
  and the resulting staircase runs up to 8.2% longer than the line it
  approximates — enough to lose to a plain straight line on a flat continental
  crossing. Sixteen headings cut that to 2.6%.
- **String pulling.** A final pass tests whether skipping ahead is faster,
  measured with the same model that times the finished route, so it can only
  improve the answer.

Together these earn the invariant the test suite enforces: **a planned route is
never slower than the direct line.** Before these fixes it lost by up to 5%.

Every route is measured against that alternative and reports the difference, so
the claim is always visible rather than asserted:

> **1.65× faster than going straight**
> 45 days, 6 hours instead of 74 days, 14 hours — arrives 29 days, 8 hours sooner
> 10.4 km/h vs 6.3 km/h as the crow flies
> swims 4,040 km instead of 11,003 km

Both routes are timed by the same pipeline over the same terrain, so the
difference is attributable to the choice of path and nothing else. Where there
is nothing worth going around, it says so instead of claiming a 1.00× gain.

Endpoints are always treated as land — cities are on land, but a coastal one can
fall in a water cell at this resolution.

## What the ground does to the pace

Two multipliers on flat-ground running speed.

**Gradient** uses Minetti et al. (2002), *Energy cost of walking and running at
extreme uphill and downhill slopes*, which fits the metabolic cost of running as
a quintic in slope. Holding metabolic power constant turns that into a speed
multiplier. Taken literally it says a 10% descent is run 1.67× faster than the
flat; no runner sustains that, so the downhill bonus is capped at 1.15×. Uphill
is left uncapped, because there the metabolic limit really is the binding one.

**Altitude** costs about 1% of VO2max per 100 m above 1500 m — the standard rule
of thumb. This is what makes a high plateau expensive rather than merely long,
and why a route will detour around one.

Both are deliberately modest. At 0.1° a cell's elevation is an 11 km average,
which smooths the Himalaya into a 5% grade rather than a wall.

Elevation comes from ETOPO1, resampled to exactly the cell centres of the land
mask. Ocean is stored as zero rather than bathymetry — a swimmer is on the
surface — which also lets 12.4 MB of grid gzip down to 2.95 MB.

## The globe

The client draws its own orthographic globe on a canvas, with no tile server
involved. A flat projection would bend the Atlantic crossing into what looks
like a detour and tear any antimeridian route in half.

It is a **topographic** map: hypsometric tint for height, relief shading for
shape, so you can see a route thread between mountains rather than over them.
The palette is deliberately not natural-earth — it starts at very nearly the
flat green the globe used before, so low ground looks unchanged, and only
brightens as it climbs, through olive and tan to snow-bleached grey. Height
reads as luminance, which leaves amber and cyan free to mean *run* and *swim*
on top of it.

The sphere is rasterised per pixel: each pixel inside the disc is projected back
to a latitude and longitude and sampled bilinearly from an equirectangular
relief image. Nearest-neighbour sampling turns a coastline into visible 20 km
blocks the moment you zoom in on a strait.

The app fetches a 982 KB PNG baked by `build:texture`. The site already carries
the elevation grid for routing, so it builds the same texture in the browser and
downloads nothing extra — both call `buildTerrainTexture`, so they cannot drift.
`src/png.js` is a small encoder written rather than depended on, since the
project has no other image toolchain.

Before the texture arrives, and on the sign-in screen, it falls back to filled
coastline polygons. Those rings straddle the limb, so they are clipped with
Sutherland-Hodgman in 3D against the view plane and stitched back along the
horizon circle between successive exit and entry points. (Without that arc the
clip closes continents off with a straight chord, and Africa grows a flat edge.)

### Steering it

**Drag** to turn the globe, **scroll** or pinch to zoom, **double-click** to
centre on a point and close in. Longitude turns faster near the poles, where
circles of latitude are short — without that the globe feels stuck up there.

Choosing a route **frames it automatically**: centred on the mean of the route's
points (not the midpoint of its endpoints, which for a route arcing through
Greenland is out in the ocean) and zoomed so the furthest point still sits
inside the disc. Taking hold of the globe yourself stops it re-aiming, and
offers a button to hand control back.

Zoom is capped at 9×. A texel is about 20 km, and past that the view would be
magnifying detail that was never in the data.

Two things had to be fixed to make this usable, both worth knowing if you touch
the renderer. Sizing the raster buffer to the *sphere* asks for an 81-megapixel
canvas once zoomed in on a short route, and hangs the page — it is sized to the
**viewport**, which is bounded however far you zoom. And repainting a
full-window canvas every frame, to animate a courier that advances a few microns
a second, spends most of the frame budget on compositing — the globe repaints
only while moving or when something asks it to.

## The project site

<https://danielluzhu.github.io/man-power/>

Published from `docs/` on `main`. It carries the sign-in links into the running
app — a sticky bar, the hero, a *Send one yourself* section and the footer — all
wired from a single `data-app` attribute on `<body>`, so moving the app is a
one-line change.

**One caveat.** That URL currently sits behind the host's proxy authentication,
so anyone who is not you gets an access wall before they ever reach the sign-on.
Making it genuinely public means a domain pointed at this machine (see *Still
needed before launch*).

It is not a brochure: it runs the *actual* routing engine client-side — the same ladder, the same coastline bitmap, the
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

### As a service

```bash
sudo deploy/install.sh
```

Installs and enables two units: the app, and Litestream replicating its
database. The installer waits for the app to actually answer before reporting
success, prints the measured clock drift, and says plainly if backups are
local-only.

```bash
systemctl status man-power litestream
journalctl -u man-power -f
curl -s localhost:4321/api/health | jq
```

## Exposed to the internet

The app sends a strict content policy, `nosniff`, a referrer policy, an opener
policy, a permissions policy denying camera, microphone, location and payment,
and HSTS once a request has arrived over HTTPS. API responses are `no-store` —
they carry sessions and phone numbers. Session cookies gain `Secure` over HTTPS
and still work over plain HTTP in development.

The content policy is strict including for styles: `'unsafe-inline'` is not
needed anywhere. That is load-bearing rather than fussy, because a violation
logs to the console and the browser suite fails on any console error — so a
policy that quietly stops matching the app cannot survive a test run. It earned
that immediately by catching a malformed permissions policy the browser was
rejecting wholesale.

`TRUST_PROXY` defaults on, because this runs behind the host's proxy and the
rate limits key on `X-Forwarded-For`. Set it to `0` if the app is ever exposed
directly, or that header becomes a way to invent an address per request.

## Running it for real

The delivery mechanic is the easy part. What makes this hard to operate is that
the core promise is a timer measured in weeks: the data has to outlive the
machine, and something has to speak up when a courier lands three weeks after
the tab was closed.

### The clock

Every arrival is `now + journey seconds`, stored once and never recomputed. That
makes deliveries immune to the server being down — but a wrong clock at *send*
time bakes a wrong arrival in permanently. The message is not late; it is wrong,
and nothing downstream can tell.

`timedatectl` reports this host as unsynchronised, which looks alarming and
isn't: it takes its time from the hypervisor via `kvm-clock` and `/dev/ptp_kvm`,
which is exactly why `systemd-timesyncd` is masked. Running an NTP daemon here
would fight the paravirtualised clock rather than help it. So the app checks the
time instead of setting it — two independent sources, on boot and hourly — and
reports the result on `/api/health`, which returns **503** when the clock is
known to be out.

### Backups

Litestream streams every transaction to a replica as it happens. That is the
right shape for SQLite, and not merely a preference: in normal operation the
write-ahead log holds megabytes the main `.sqlite` file does not yet contain. On
this machine it was **2.4 MB of WAL against a 4 KB database** — a backup script
copying `data/manpower.sqlite` alone would have faithfully saved an almost empty
file.

```bash
deploy/restore.sh          # restore to a temp file and verify it — safe any time
sudo deploy/restore.sh --live   # stop the app, swap it in, start it again
```

The default is harmless on purpose: it proves the backup is restorable without
touching anything, and checks integrity and row counts rather than just that a
file appeared. Run it now and then. An untested backup is a guess, and this one
is holding messages that are weeks from arriving.

**The replica is currently local**, which survives an accidental delete, a bad
migration or corruption — but not losing the machine. Real off-machine
durability needs a bucket; the S3 stanza is written and commented in
`deploy/litestream.yml`, and credentials come from
`/etc/man-power/litestream.env`, so nothing secret is committed.

### Signing in

Accounts are phone numbers. There are no passwords.

Signing in and enlisting are one flow — a number, a code, and for a number
nobody has used before, a handle and a home. That is partly kindness, and
partly that a separate sign-up would answer *"is this number registered?"* for
anyone who cared to ask.

The number is the identity and never leaves the server: it is absent from every
response about somebody else, and its owner sees only a masked form of their
own.

**The flow.** Three steps, drawn as waypoints on a route so it is obvious how
short it is. On Android Chrome the code fills itself in: the text message ends
with a line naming this exact origin, which is the handshake **WebOTP** looks
for, so the browser reads the code out of the message and signs you in without
a keystroke. Set `PUBLIC_ORIGIN` to wherever the app answers from — if it does
not match, nothing breaks visibly, the code simply stops autofilling. The code is six boxes behaving as one field — pasting from a
message fills all of them and submits, autofill works, backspace walks
backwards, and the sixth digit signs you in without reaching for a button. A
wrong code clears the boxes rather than leaving the mistake sitting there.

Both of the server's real limits are visible rather than sprung on you: the code
counts down to its expiry, and resending is held off with the wait shown. Naming
your city sends the globe behind the card to go and look at it.

**Getting there without sight.** Each step is announced, the current waypoint
carries `aria-current`, and errors announce themselves. The expiry countdown is
deliberately *not* a live region — read out every second it would make the page
unusable. Under a reduced-motion preference the steps appear rather than slide
and a working button says so in words, since a frozen spinner is worse than
none.

**Codes.** Six digits is a weak secret by construction, so: stored as an HMAC
bound to the number, expiring in ten minutes, burned after five wrong guesses,
cancelled when a new one is asked for, and compared in constant time. The
attempt is counted *before* it is checked, so a crash mid-verify cannot buy a
free guess.

### Sending the codes for real

With no credentials the app writes codes to its journal, which makes the whole
flow work on a development machine and is unusable in public — anyone who can
read the log can sign in as anyone. The sign-in page says so outright rather
than claiming a message is on its way.

Put credentials in `/etc/man-power/sms.env` (the installer creates it, root-owned
and group-readable by the service) and restart:

| Provider | Variables |
|---|---|
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| Vonage | `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_FROM` |

```bash
sudo systemctl restart man-power
bun run sms:test +447911123456     # sends one real message
```

Run that before trusting it. Credentials that look right and do not work are the
expensive failure here: the app starts, the page promises a code, and nobody
finds out until someone waits for a text sitting in a log. Both providers'
trials only text numbers verified with them, which is the usual first surprise.

Half-configuring a provider is refused at startup, naming what is missing.
Falling back to the journal there would look like it works, right up until it
mattered.

`PUBLIC_ORIGIN` belongs in the same file — WebOTP only autofills when the
message names the origin the app actually answers from.

**Numbers are normalised to E.164** with libphonenumber rather than a regular
expression. Once a number is an identity, `+44 7911 123456`, `07911 123456` and
`00447911123456` have to collapse to one account, or that person gets three and
loses the messages in two.

There is no migration from the password era: identity is now the number, and a
password account has no number to become. An empty legacy table is rebuilt; one
with accounts in it stops the server with an explanation rather than quietly
destroying people.

### Telling people

Arrival used to be evaluated only when someone loaded the page — fine for
deciding what to show, useless as a product, since nobody keeps a tab open for
three weeks. A worker now asks the database what has arrived and not been
announced, tells the notification channels, and marks it.

State lives in the database rather than in scheduled timers, because a timer set
for three weeks' time does not survive a deploy, and this service will be
deployed many times before some of its couriers land. Delivery is
**at-least-once**: a crash mid-dispatch replays an arrival rather than losing it,
because a duplicate notification is an annoyance and a missing one defeats the
premise.

Notifications go out over **Web Push** — no mail provider, no domain, no account
with anyone. They name the sender and how far they came, never the message
itself. On iOS this only works once the site is added to the home screen;
desktop and Android need nothing.

The VAPID keypair is generated on first run into `data/vapid.json` and is
**not** in the repository. Every existing subscription is bound to it, so
regenerating it makes every subscribed browser go silent — keep it with the
database.

### Limits

| Action | Ceiling | Keyed on | Override |
|---|---|---|---|
| Request a code | 3 / hour | number | `LIMIT_CODE_PER_PHONE` |
| Request a code | 15 / hour | address | `LIMIT_CODE_PER_HOST` |
| Check a code | 10 / 15 min | number | `LIMIT_VERIFY_PER_PHONE` |
| Check a code | 60 / 15 min | address | `LIMIT_VERIFY_PER_HOST` |
| Enlist | 20 / hour | address | `LIMIT_REGISTER` |
| Send | 20 / hour | courier | `LIMIT_SEND` |
| Quote a route | 60 / min | courier | `LIMIT_PREVIEW` |
| City search | 120 / min | address | `LIMIT_SEARCH` |

Two of these are shaped by specific attacks rather than by taste.

**Requesting a code costs money**, so pointing that endpoint at numbers an
attacker controls turns a sign-in form into a bill. Hence a tight per-number
ceiling as well as a per-address one.

**Checking a code is keyed on the number first.** Keying it on the address alone
means an office behind one NAT shares one allowance and locks itself out — which
is exactly what happened to the test suite. Guessing is really bounded by the
five attempts a single code allows; these limits exist to stop someone working
through *numbers*, so the tight one belongs on the number and the address gets a
looser backstop. The
app trusts `X-Forwarded-For` because it runs behind a proxy; set `TRUST_PROXY=0`
if it ever does not, or the header becomes a way to invent an address per
request and walk past all of the above.

## Still needed before launch

Three things are blocked on decisions or credentials rather than code.

- **Off-machine backups.** One bucket and four environment variables away; see
  `deploy/litestream.yml`. Until then a lost machine is lost messages.
- **An SMS provider.** The whole sign-in flow works today with codes going to
  the journal, which is fine for development and unusable in public — anyone who
  can read the log can sign in as anyone. Three environment variables away.
- **A domain and TLS.** A messaging service needs an address people can return
  to weeks later — and until there is one, the landing page's *Sign in* buttons
  lead to the host's proxy login rather than to the app.
- **A moderation stance.** The product's rule is that nobody reads a message
  before it arrives, which is also what makes abuse hard: a recipient cannot
  report for three weeks, and a sealed message cannot be scanned. The server
  does hold the plaintext at send time, so screening before sealing is possible
  — it just costs a little of the idea. Worth choosing deliberately rather than
  discovering after launch.

### Tests

```bash
bun test                   # pace model, terrain physics, routing invariants
bun run test:browser       # drives the real app in headless Chromium
bun run test:site          # rebuilds docs/ and drives the project site
```

Push cannot be tested end to end — real delivery ends at Google's or Mozilla's
servers — so the tests cover both sides of that boundary instead: that payloads
really are encrypted and signed, and that the routing and pruning logic around
the send behaves.

The browser and site suites also assert the globe behaves: that choosing a route
reframes the camera, and that dragging actually turns it.

`test:site` exists for one specific failure: the site runs *copies* of the
engine made by `build:site`, so editing the router and forgetting to rebuild
leaves the published page quietly answering with the old engine while every
other test passes. It rebuilds first, then checks the page reports what the
current engine actually computes.

The browser test exists because the worst bugs here were invisible to unit
tests: a CSS rule that silently defeated the `[hidden]` attribute and rendered
two screens on top of each other, an invalid `pattern` attribute, and a city
search that could not find "Zürich" if you typed "Zurich".

## Layout

```
server.js              HTTP server and JSON API
src/records.js         world-record ladders and the pace curve
src/geo.js             plans a route, then measures and times it
src/router.js          least-time A* pathfinding over the world grid
src/terrain.js         gradient and altitude physics, elevation grid
src/terrain-texture.js shaded-relief map, shared by the app and the site
src/png.js             minimal PNG encoder, for baking the globe texture
src/sphere.js          pure great-circle math, shared with the browser
src/db.js              SQLite storage and additive migrations
src/clock.js           checks the time the whole product rests on
src/delivery.js        notices arrivals and announces them
src/push.js            web push notifications
src/ratelimit.js       ceilings on enlisting, signing in and sending
src/phone.js           E.164 normalisation — one person, one identity
src/verification.js    SMS codes: issue, check, expire, burn
src/sms.js             SMS transport (Twilio, or the journal in development)
src/secrets.js         server keys that outlive a restart
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
- Elevation: [ETOPO1](https://www.ncei.noaa.gov/products/etopo-global-relief-model)
  (NOAA), fetched via ERDDAP at exactly the grid's cell centres — used both for
  routing and for shading the globe.

## Caveats, cheerfully admitted

The courier goes around mountains but not around anything else: no roads, no
borders, no rivers, no jungle, no ice. They do not sleep, eat, or wait for
weather, and ocean currents do not exist. Terrain is averaged over 11 km cells,
so real gradients are gentler here than underfoot. And they hold marathon
world-record pace for six thousand kilometres, which is the whole joke.
