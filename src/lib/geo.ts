/** Map coordinates for properties (portfolio map).
 *
 * Order of truth: a property's own lat/lng (set at creation or on the
 * property record) → its city's centroid from the table below → its state's
 * centroid. Centroid fallbacks get a small deterministic offset derived from
 * the property id so two properties in the same city render as two distinct
 * pins instead of one stacked marker. No network calls — works offline. */

const CITY: Record<string, [number, number]> = {
  'new york|ny': [40.7128, -74.006], 'los angeles|ca': [34.0522, -118.2437], 'chicago|il': [41.8781, -87.6298],
  'houston|tx': [29.7604, -95.3698], 'phoenix|az': [33.4484, -112.074], 'philadelphia|pa': [39.9526, -75.1652],
  'san antonio|tx': [29.4241, -98.4936], 'san diego|ca': [32.7157, -117.1611], 'dallas|tx': [32.7767, -96.797],
  'austin|tx': [30.2672, -97.7431], 'jacksonville|fl': [30.3322, -81.6557], 'fort worth|tx': [32.7555, -97.3308],
  'columbus|oh': [39.9612, -82.9988], 'charlotte|nc': [35.2271, -80.8431], 'indianapolis|in': [39.7684, -86.1581],
  'san francisco|ca': [37.7749, -122.4194], 'seattle|wa': [47.6062, -122.3321], 'denver|co': [39.7392, -104.9903],
  'washington|dc': [38.9072, -77.0369], 'nashville|tn': [36.1627, -86.7816], 'oklahoma city|ok': [35.4676, -97.5164],
  'el paso|tx': [31.7619, -106.485], 'boston|ma': [42.3601, -71.0589], 'portland|or': [45.5152, -122.6784],
  'las vegas|nv': [36.1699, -115.1398], 'detroit|mi': [42.3314, -83.0458], 'memphis|tn': [35.1495, -90.049],
  'louisville|ky': [38.2527, -85.7585], 'baltimore|md': [39.2904, -76.6122], 'milwaukee|wi': [43.0389, -87.9065],
  'albuquerque|nm': [35.0844, -106.6504], 'tucson|az': [32.2226, -110.9747], 'fresno|ca': [36.7378, -119.7871],
  'sacramento|ca': [38.5816, -121.4944], 'kansas city|mo': [39.0997, -94.5786], 'mesa|az': [33.4152, -111.8315],
  'atlanta|ga': [33.749, -84.388], 'omaha|ne': [41.2565, -95.9345], 'colorado springs|co': [38.8339, -104.8214],
  'raleigh|nc': [35.7796, -78.6382], 'miami|fl': [25.7617, -80.1918], 'virginia beach|va': [36.8529, -75.978],
  'oakland|ca': [37.8044, -122.2712], 'minneapolis|mn': [44.9778, -93.265], 'tulsa|ok': [36.154, -95.9928],
  'tampa|fl': [27.9506, -82.4572], 'arlington|tx': [32.7357, -97.1081], 'arlington|va': [38.8816, -77.091],
  'new orleans|la': [29.9511, -90.0715], 'wichita|ks': [37.6872, -97.3301], 'cleveland|oh': [41.4993, -81.6944],
  'bakersfield|ca': [35.3733, -119.0187], 'aurora|co': [39.7294, -104.8319], 'anaheim|ca': [33.8366, -117.9143],
  'honolulu|hi': [21.3099, -157.8581], 'santa ana|ca': [33.7455, -117.8677], 'riverside|ca': [33.9806, -117.3755],
  'corpus christi|tx': [27.8006, -97.3964], 'lexington|ky': [38.0406, -84.5037], 'stockton|ca': [37.9577, -121.2908],
  'st. louis|mo': [38.627, -90.1994], 'saint louis|mo': [38.627, -90.1994], 'st. paul|mn': [44.9537, -93.09],
  'saint paul|mn': [44.9537, -93.09], 'cincinnati|oh': [39.1031, -84.512], 'pittsburgh|pa': [40.4406, -79.9959],
  'greensboro|nc': [36.0726, -79.792], 'anchorage|ak': [61.2181, -149.9003], 'plano|tx': [33.0198, -96.6989],
  'lincoln|ne': [40.8136, -96.7026], 'orlando|fl': [28.5383, -81.3792], 'irvine|ca': [33.6846, -117.8265],
  'newark|nj': [40.7357, -74.1724], 'toledo|oh': [41.6528, -83.5379], 'durham|nc': [35.994, -78.8986],
  'chula vista|ca': [32.6401, -117.0842], 'fort wayne|in': [41.0793, -85.1394], 'jersey city|nj': [40.7178, -74.0431],
  'st. petersburg|fl': [27.7676, -82.6403], 'laredo|tx': [27.5306, -99.4803], 'madison|wi': [43.0731, -89.4012],
  'chandler|az': [33.3062, -111.8413], 'buffalo|ny': [42.8864, -78.8784], 'lubbock|tx': [33.5779, -101.8552],
  'scottsdale|az': [33.4942, -111.9261], 'reno|nv': [39.5296, -119.8138], 'glendale|az': [33.5387, -112.186],
  'gilbert|az': [33.3528, -111.789], 'winston-salem|nc': [36.0999, -80.2442], 'north las vegas|nv': [36.1989, -115.1175],
  'norfolk|va': [36.8508, -76.2859], 'chesapeake|va': [36.7682, -76.2875], 'garland|tx': [32.9126, -96.6389],
  'irving|tx': [32.814, -96.9489], 'hialeah|fl': [25.8576, -80.2781], 'fremont|ca': [37.5485, -121.9886],
  'boise|id': [43.615, -116.2023], 'richmond|va': [37.5407, -77.436], 'baton rouge|la': [30.4515, -91.1871],
  'spokane|wa': [47.6588, -117.426], 'des moines|ia': [41.5868, -93.625], 'tacoma|wa': [47.2529, -122.4443],
  'san bernardino|ca': [34.1083, -117.2898], 'modesto|ca': [37.6391, -120.9969], 'fontana|ca': [34.0922, -117.435],
  'santa clarita|ca': [34.3917, -118.5426], 'birmingham|al': [33.5186, -86.8104], 'oxnard|ca': [34.1975, -119.1771],
  'fayetteville|nc': [35.0527, -78.8784], 'moreno valley|ca': [33.9425, -117.2297], 'rochester|ny': [43.1566, -77.6088],
  'glendale|ca': [34.1425, -118.2551], 'huntington beach|ca': [33.6595, -117.9988], 'salt lake city|ut': [40.7608, -111.891],
  'grand rapids|mi': [42.9634, -85.6681], 'amarillo|tx': [35.222, -101.8313], 'yonkers|ny': [40.9312, -73.8988],
  'aurora|il': [41.7606, -88.3201], 'montgomery|al': [32.3668, -86.3], 'akron|oh': [41.0814, -81.519],
  'little rock|ar': [34.7465, -92.2896], 'huntsville|al': [34.7304, -86.5861], 'augusta|ga': [33.4735, -82.0105],
  'port st. lucie|fl': [27.273, -80.3582], 'grand prairie|tx': [32.746, -96.9978], 'columbus|ga': [32.4609, -84.9877],
  'tallahassee|fl': [30.4383, -84.2807], 'overland park|ks': [38.9822, -94.6708], 'tempe|az': [33.4255, -111.94],
  'mckinney|tx': [33.1972, -96.6398], 'mobile|al': [30.6954, -88.0399], 'cape coral|fl': [26.5629, -81.9495],
  'shreveport|la': [32.5252, -93.7502], 'frisco|tx': [33.1507, -96.8236], 'knoxville|tn': [35.9606, -83.9207],
  'worcester|ma': [42.2626, -71.8023], 'brownsville|tx': [25.9018, -97.4975], 'vancouver|wa': [45.6387, -122.6615],
  'fort lauderdale|fl': [26.1224, -80.1373], 'sioux falls|sd': [43.5446, -96.7311], 'ontario|ca': [34.0633, -117.6509],
  'chattanooga|tn': [35.0456, -85.3097], 'providence|ri': [41.824, -71.4128], 'newport news|va': [37.0871, -76.473],
  'rancho cucamonga|ca': [34.1064, -117.5931], 'santa rosa|ca': [38.4404, -122.7141], 'oceanside|ca': [33.1959, -117.3795],
  'salem|or': [44.9429, -123.0351], 'elk grove|ca': [38.4088, -121.3716], 'garden grove|ca': [33.7743, -117.9378],
  'pembroke pines|fl': [26.0078, -80.2963], 'peoria|az': [33.5806, -112.2374], 'eugene|or': [44.0521, -123.0868],
  'corona|ca': [33.8753, -117.5664], 'cary|nc': [35.7915, -78.7811], 'springfield|mo': [37.2089, -93.2923],
  'fort collins|co': [40.5853, -105.0844], 'jackson|ms': [32.2988, -90.1848], 'alexandria|va': [38.8048, -77.0469],
  'hayward|ca': [37.6688, -122.0808], 'lancaster|ca': [34.6868, -118.1542], 'lakewood|co': [39.7047, -105.0814],
  'clarksville|tn': [36.5298, -87.3595], 'palmdale|ca': [34.5794, -118.1165], 'salinas|ca': [36.6777, -121.6555],
  'springfield|ma': [42.1015, -72.5898], 'hollywood|fl': [26.0112, -80.1495], 'pasadena|tx': [29.6911, -95.2091],
  'sunnyvale|ca': [37.3688, -122.0363], 'macon|ga': [32.8407, -83.6324], 'pomona|ca': [34.0551, -117.7499],
  'escondido|ca': [33.1192, -117.0864], 'killeen|tx': [31.1171, -97.7278], 'naperville|il': [41.7508, -88.1535],
  'joliet|il': [41.525, -88.0817], 'bellevue|wa': [47.6101, -122.2015], 'rockford|il': [42.2711, -89.094],
  'savannah|ga': [32.0809, -81.0912], 'paterson|nj': [40.9168, -74.1718], 'torrance|ca': [33.8358, -118.3406],
  'bridgeport|ct': [41.1865, -73.1952], 'mesquite|tx': [32.7668, -96.5992], 'pasadena|ca': [34.1478, -118.1445],
  'olathe|ks': [38.8814, -94.8191], 'mcallen|tx': [26.2034, -98.23], 'charleston|sc': [32.7765, -79.9311],
  'waco|tx': [31.5493, -97.1467], 'denton|tx': [33.2148, -97.1331], 'columbia|sc': [34.0007, -81.0348],
  'ann arbor|mi': [42.2808, -83.743], 'boulder|co': [40.015, -105.2705], 'asheville|nc': [35.5951, -82.5515],
};

const STATE: Record<string, [number, number]> = {
  al: [32.8067, -86.7911], ak: [61.3707, -152.4044], az: [33.7298, -111.4312], ar: [34.9697, -92.3731],
  ca: [36.1162, -119.6816], co: [39.0598, -105.3111], ct: [41.5978, -72.7554], de: [39.3185, -75.5071],
  dc: [38.9072, -77.0369], fl: [27.7663, -81.6868], ga: [33.0406, -83.6431], hi: [21.0943, -157.4983],
  id: [44.2405, -114.4788], il: [40.3495, -88.9861], in: [39.8494, -86.2583], ia: [42.0115, -93.2105],
  ks: [38.5266, -96.7265], ky: [37.6681, -84.6701], la: [31.1695, -91.8678], me: [44.6939, -69.3819],
  md: [39.0639, -76.8021], ma: [42.2302, -71.5301], mi: [43.3266, -84.5361], mn: [45.6945, -93.9002],
  ms: [32.7416, -89.6787], mo: [38.4561, -92.2884], mt: [46.9219, -110.4544], ne: [41.1254, -98.2681],
  nv: [38.3135, -117.0554], nh: [43.4525, -71.5639], nj: [40.2989, -74.521], nm: [34.8405, -106.2485],
  ny: [42.1657, -74.9481], nc: [35.6301, -79.8064], nd: [47.5289, -99.784], oh: [40.3888, -82.7649],
  ok: [35.5653, -96.9289], or: [44.572, -122.0709], pa: [40.5908, -77.2098], ri: [41.6809, -71.5118],
  sc: [33.8569, -80.945], sd: [44.2998, -99.4388], tn: [35.7478, -86.6923], tx: [31.0545, -97.5635],
  ut: [40.15, -111.8624], vt: [44.0459, -72.7107], va: [37.7693, -78.17], wa: [47.4009, -121.4905],
  wv: [38.4912, -80.9545], wi: [44.2685, -89.6165], wy: [42.756, -107.3025],
};

export interface GeoPoint {
  lat: number;
  lng: number;
  /** false when this is a centroid fallback rather than the property's own pin */
  precise: boolean;
}

/** Small deterministic offset (±~0.011°, ≈1.2km) from an id string, so
 * same-city properties spread out instead of stacking. */
function jitter(seed: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000 - 0.5;
  const b = (((h >>> 10) >>> 0) % 1000) / 1000 - 0.5;
  return [a * 0.022, b * 0.028];
}

export function propertyCoords(p: { id: string; city?: string | null; state?: string | null; lat?: number | null; lng?: number | null }): GeoPoint | null {
  if (typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng)) {
    return { lat: p.lat, lng: p.lng, precise: true };
  }
  const st = String(p.state || '').trim().toLowerCase();
  const city = String(p.city || '').trim().toLowerCase();
  const c = CITY[`${city}|${st}`];
  const [ja, jb] = jitter(p.id);
  if (c) return { lat: c[0] + ja, lng: c[1] + jb, precise: false };
  const s = STATE[st];
  if (s) return { lat: s[0] + ja * 6, lng: s[1] + jb * 6, precise: false };
  return null;
}
