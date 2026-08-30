/**
 * build-site.js — assemble the static site published to GitHub Pages.
 *
 * The site is not a brochure with screenshots. It runs the *real* routing
 * engine in the browser: the same records ladder, the same great-circle
 * splitting, the same land mask. Only the messaging half needs a server, and a
 * route calculator is the interesting half to show anyway.
 *
 * So rather than keeping a parallel copy of the engine, this copies the actual
 * modules into docs/lib/ on every build. If the pace model changes, the site
 * changes with it.
 */

const LIB_SOURCES = {
  "records.js": "src/records.js",
  "sphere.js": "src/sphere.js",
  "geo.js": "src/geo.js",
  "globe.js": "public/globe.js",
};

const DATA_SOURCES = {
  "landmask.bin": "data/landmask.bin",
  "world.json": "public/world.json",
};

/**
 * The app searches 34,125 cities server-side. The site has to ship its
 * gazetteer to every visitor, so it carries the largest few thousand instead —
 * enough that every recognisable city is present, at a tenth of the size.
 */
const CITY_LIMIT = 3000;

async function copy(from, to) {
  await Bun.write(to, Bun.file(from));
  return Bun.file(to).size;
}

let total = 0;

for (const [name, src] of Object.entries(LIB_SOURCES)) {
  total += await copy(src, `docs/lib/${name}`);
}
for (const [name, src] of Object.entries(DATA_SOURCES)) {
  total += await copy(src, `docs/data/${name}`);
}

// Trim the gazetteer, keeping the compact tuple shape the app already uses.
const { cities, countries } = await Bun.file("data/cities.json").json();
const trimmed = cities.slice(0, CITY_LIMIT);
const used = new Set(trimmed.map((c) => c[1]));
const names = Object.fromEntries(Object.entries(countries).filter(([code]) => used.has(code)));

await Bun.write("docs/data/cities.json", JSON.stringify({ countries: names, cities: trimmed }));
total += Bun.file("docs/data/cities.json").size;

// GitHub Pages runs Jekyll by default, which would filter parts of this tree.
await Bun.write("docs/.nojekyll", "");

const smallest = trimmed[trimmed.length - 1];
console.log(`Copied ${Object.keys(LIB_SOURCES).length} modules and ${Object.keys(DATA_SOURCES).length + 1} datasets`);
console.log(`Gazetteer trimmed to ${trimmed.length} cities (down to ${smallest[0]}, pop. ${smallest[5].toLocaleString()})`);
console.log(`docs/ payload: ${(total / 1024).toFixed(0)} KB uncompressed`);
