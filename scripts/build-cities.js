/**
 * build-cities.js — compile a searchable world city gazetteer.
 *
 * Source: GeoNames cities15000 (every city over 15,000 people) plus
 * countryInfo for country names. Both are CC BY 4.0.
 *
 * Output: data/cities.json — an array of compact tuples rather than objects,
 * which roughly halves the file size for ~34,000 entries:
 *   [name, countryCode, admin1, lat, lon, population]
 */

const CITIES_URL = "http://download.geonames.org/export/dump/cities15000.zip";
const COUNTRY_URL = "http://download.geonames.org/export/dump/countryInfo.txt";
const CITIES_TSV = "data/cities15000.txt";
const COUNTRY_TSV = "data/countryInfo.txt";
const OUT_PATH = "data/cities.json";

async function ensure(path, url, { zipped = false } = {}) {
  const file = Bun.file(path);
  if (await file.exists()) return file.text();
  console.log(`Fetching ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  if (!zipped) {
    const text = await res.text();
    await Bun.write(path, text);
    return text;
  }
  const tmp = `${path}.zip`;
  await Bun.write(tmp, await res.arrayBuffer());
  await Bun.$`unzip -o -q ${tmp} -d ${path.replace(/\/[^/]+$/, "")}`;
  await Bun.$`rm -f ${tmp}`;
  return Bun.file(path).text();
}

const countryText = await ensure(COUNTRY_TSV, COUNTRY_URL);
const countries = {};
for (const line of countryText.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const f = line.split("\t");
  if (f.length > 4 && f[0]) countries[f[0]] = f[4];
}

const citiesText = await ensure(CITIES_TSV, CITIES_URL, { zipped: true });

const cities = [];
for (const line of citiesText.split("\n")) {
  if (!line.trim()) continue;
  const f = line.split("\t");
  const [, name, , , lat, lon, , , country, , admin1] = f;
  const population = Number(f[14]) || 0;
  if (!name || !lat || !lon) continue;
  cities.push([
    name,
    country,
    admin1 || "",
    Math.round(Number(lat) * 1e4) / 1e4,
    Math.round(Number(lon) * 1e4) / 1e4,
    population,
  ]);
}

// Biggest first: search results then rank by prominence without extra sorting.
cities.sort((a, b) => b[5] - a[5]);

const payload = { countries, cities };
await Bun.write(OUT_PATH, JSON.stringify(payload));

const kb = ((await Bun.file(OUT_PATH).size) / 1024).toFixed(0);
console.log(`Wrote ${OUT_PATH} — ${cities.length} cities, ${Object.keys(countries).length} countries, ${kb} KB`);
console.log(`Largest: ${cities.slice(0, 3).map((c) => `${c[0]} (${c[5].toLocaleString()})`).join(", ")}`);
