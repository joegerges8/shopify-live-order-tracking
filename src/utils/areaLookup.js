// areaLookup.js
//
// Resolves the free-text city string that comes from the Shopify checkout into
// a delivery area (a Lebanese caza), so orders can be filtered by area in the
// driver app and on the dispatcher dashboard.
//
// Why this exists at all: Shopify gives us `shipping_address.city` as whatever
// the customer typed, and `shipping_address.province` is null on effectively
// every Lebanese order. Even when province is present it is the governorate
// (Mount Lebanon), which cannot distinguish Keserwan from Jbeil. So the area
// has to be derived from the city text.
//
// The table below was built from 3 years of real order history: 1,613 orders
// containing 532 distinct city strings. What that history showed is that the
// strings are rarely clean town names — they are town names with noise:
//
//   "Zahle Madine", "Zahle Saadneyl", "Zahle Haouch El Omara El Ardi", "zahle"
//   "Achrafieh - Beirut - Towards Sassine - Building Next To Pizzanini"
//   "Kfarhabab  Kesrwan", "Adma (kesserwan)", "Furn El Shebbak - Zone C"
//
// So matching is deliberately NOT exact-string. A city matches if a known town
// name appears inside it as a whole word, which collapses every variant of a
// town onto one table entry and absorbs future ones for free.
//
// Matching order (first hit wins):
//   1. Exact match on the normalized string.
//   2. Longest whole-word match anywhere in the string. Longest matters:
//      "ras el metn" must beat "metn", because Ras el Metn is in Baabda.
//   3. Fuzzy match (one edit) for single-word typos: "Beirur", "Beurut".
//   4. No match -> null, which the caller stores as "Other".

// Every area we classify into. These are Lebanon's cazas (districts), which is
// the granularity a dispatcher thinks in — governorates are too coarse.
const AREAS = [
  "Beirut",
  "Baabda",
  "Metn",
  "Keserwan",
  "Jbeil",
  "Aley",
  "Chouf",
  "Batroun",
  "Koura",
  "Tripoli",
  "Zgharta",
  "Bsharri",
  "Minieh-Danniyeh",
  "Akkar",
  "Zahle",
  "West Bekaa",
  "Rachaya",
  "Baalbek",
  "Hermel",
  "Saida",
  "Jezzine",
  "Sour",
  "Nabatieh",
  "Bint Jbeil",
  "Marjeyoun",
  "Hasbaya",
];

// The label used when a city cannot be resolved. Orders keep showing up in the
// list under this label — they are never hidden, just unfiled.
const UNKNOWN_AREA = "Other";

// Town/neighbourhood -> area. Keys must be pre-normalized (lowercase, no
// accents, no punctuation, single spaces) because they are compared against
// normalize() output. Add a new key here to teach the system a new town; no
// app release is needed, only a backend deploy.
const TOWN_TO_AREA = {
  // ── Beirut ────────────────────────────────────────────────────────────────
  beirut: "Beirut", beyrouth: "Beirut", bayrut: "Beirut", beirout: "Beirut",
  beyrout: "Beirut", beirur: "Beirut", beurut: "Beirut", bayrout: "Beirut",
  achrafieh: "Beirut", ashrafieh: "Beirut", achrafiyeh: "Beirut",
  sassine: "Beirut", gemmayzeh: "Beirut", "mar mikhael": "Beirut",
  hamra: "Beirut", manara: "Beirut", "ras beirut": "Beirut", koraytem: "Beirut",
  verdun: "Beirut", sanayeh: "Beirut", msaytbeh: "Beirut", zarif: "Beirut",
  basta: "Beirut", "mar elias": "Beirut", mazraa: "Beirut",
  "kornish el mazraa": "Beirut", "corniche el mazraa": "Beirut",
  "talet khayat": "Beirut", unesco: "Beirut", raoucheh: "Beirut",
  rouche: "Beirut", badaro: "Beirut", sodeco: "Beirut", monot: "Beirut",
  adlieh: "Beirut", mathaf: "Beirut", karantina: "Beirut", downtown: "Beirut",
  "minet el hosn": "Beirut", "ain mressieh": "Beirut", "ain mreisseh": "Beirut",
  "jesr el wati": "Beirut", "jesr l wate": "Beirut", jnah: "Beirut",
  "bir hasan": "Beirut", "tariq el matar": "Beirut", "furn el hayek": "Beirut",
  بيروت: "Beirut",

  // ── Baabda ────────────────────────────────────────────────────────────────
  // Includes the Beirut-adjacent suburbs (Hazmieh, Furn el Chebbak, Ain el
  // Remmaneh) and the southern suburbs, which all sit in Baabda caza.
  baabda: "Baabda", hadat: "Baabda", hadath: "Baabda", hazmieh: "Baabda",
  hazmiyeh: "Baabda", hazmyeh: "Baabda", hazmiye: "Baabda",
  "forn el chebbak": "Baabda", "furn el shebbak": "Baabda",
  "forn el chebbak zone c": "Baabda", "furn el chebbak": "Baabda",
  "forn el shebak": "Baabda", "ain el remmaneh": "Baabda",
  "ain remmeneh": "Baabda", "ain el rummaneh": "Baabda", chiyah: "Baabda",
  chiah: "Baabda", "haret hreik": "Baabda", "bir el abed": "Baabda",
  mrayje: "Baabda", dahye: "Baabda", ghobeiry: "Baabda", faiyadiyeh: "Baabda",
  fayadieh: "Baabda", yarze: "Baabda", louaizeh: "Baabda", louaizi: "Baabda",
  kfarshima: "Baabda", kfarchima: "Baabda", "kfar chima": "Baabda",
  "wadi chahrour": "Baabda", "wadi el chahrour": "Baabda",
  "deir koubel": "Baabda", deirkoubel: "Baabda", "deir qoubel": "Baabda",
  jamhour: "Baabda", hammana: "Baabda", salima: "Baabda", "ras el metn": "Baabda",
  "ras el matn": "Baabda", "el mrouj": "Baabda", mcharrafieh: "Baabda",
  mchrfye: "Baabda", المشرفية: "Baabda", "haret hreyk": "Baabda",

  // ── Metn ──────────────────────────────────────────────────────────────────
  metn: "Metn", matn: "Metn", maten: "Metn", "north metn": "Metn",
  fanar: "Metn", jdeideh: "Metn", jdaideh: "Metn", jdeidet: "Metn",
  "sin el fil": "Metn", "sen el fil": "Metn", "sinn el fil": "Metn",
  sinelfil: "Metn", awkar: "Metn", aaoukar: "Metn", aoukar: "Metn",
  "beit chabeb": "Metn", "beit chabab": "Metn",
  "horch tabet": "Metn", "horsh tabet": "Metn", dekwaneh: "Metn",
  dekwene: "Metn", dekweneh: "Metn", dekouane: "Metn", mkalles: "Metn",
  baouchriyeh: "Metn", bouchriye: "Metn", bocherie: "Metn",
  "bourj hammoud": "Metn", "borj hammoud": "Metn", "burj hammoud": "Metn",
  dora: "Metn", daoura: "Metn", "mirna chalouhi": "Metn",
  "mirna chelohi": "Metn", "jal el dib": "Metn", zalka: "Metn", zalqa: "Metn",
  "nahr el mot": "Metn", antelias: "Metn", naccache: "Metn", naqqache: "Metn",
  naccashe: "Metn", dbayeh: "Metn", dbaiyeh: "Metn", dbaye: "Metn",
  dubayyah: "Metn", dabye: "Metn", rabieh: "Metn", rabweh: "Metn",
  raboueh: "Metn", rabwe: "Metn", mtayleb: "Metn", mtaileb: "Metn",
  biyada: "Metn", biyyadah: "Metn", biakout: "Metn", byakout: "Metn",
  biaqout: "Metn", bkenaya: "Metn", bqennaya: "Metn",
  "mazraat yachoua": "Metn", "mazraat yachouaa": "Metn",
  "mazraat yashou": "Metn", "dik el mehdi": "Metn", "dik ek mehdi": "Metn",
  "beit el koukou": "Metn",
  "cornet chehwan": "Metn", "kornet chehwan": "Metn",
  "cornet chahwan": "Metn", "kornet chahwan": "Metn",
  "qornet el hamra": "Metn", "kornet el hamra": "Metn", "beit meri": "Metn",
  beitmeri: "Metn", "beit merry": "Metn", broummana: "Metn", baabdat: "Metn",
  sfayleh: "Metn", sfaileh: "Metn", mansourieh: "Metn", mansouriye: "Metn",
  "ain saadeh": "Metn", "ain saade": "Metn", "ain aalak": "Metn",
  "ain alak": "Metn", bsalim: "Metn", mezher: "Metn", roumieh: "Metn",
  bikfaiya: "Metn", bikfaya: "Metn", beskinta: "Metn",
  "dhour el choueir": "Metn", monteverde: "Metn", montiverdi: "Metn",
  "mar roukoz": "Metn", "mar roukouz": "Metn", sabtieh: "Metn",
  sabtiyeh: "Metn", "new rawda": "Metn", rawda: "Metn", hbous: "Metn",
  "ain najem": "Metn", nabay: "Metn", "beit misk": "Metn",
  "mar chaaya": "Metn", zikrit: "Metn", "beit el chaar": "Metn",
  "beit ech cheaar": "Metn", betchay: "Metn", bteghrine: "Metn",
  "dahr el souane": "Metn", "dahr el sawan": "Metn",

  // ── Keserwan ──────────────────────────────────────────────────────────────
  keserwan: "Keserwan", kesrwan: "Keserwan", kesserwan: "Keserwan",
  kersewan: "Keserwan", keserwean: "Keserwan", keserwen: "Keserwan",
  kesrouen: "Keserwan", jounieh: "Keserwan", jounie: "Keserwan",
  jounyh: "Keserwan", jouniye: "Keserwan", junieh: "Keserwan",
  kaslik: "Keserwan",
  sarba: "Keserwan", ghadir: "Keserwan", "zouk mosbeh": "Keserwan",
  "zouq mosbeh": "Keserwan", "zouk mikael": "Keserwan",
  "zouk mikhael": "Keserwan", "zouk mkayel": "Keserwan", zouk: "Keserwan",
  adonis: "Keserwan", adma: "Keserwan", dafna: "Keserwan", ballouneh: "Keserwan",
  ajaltoun: "Keserwan", ajaltoune: "Keserwan", ajaltun: "Keserwan",
  sehayle: "Keserwan", sehaile: "Keserwan", shayle: "Keserwan",
  shaile: "Keserwan", shayleh: "Keserwan", faytroun: "Keserwan",
  faitroun: "Keserwan", fatka: "Keserwan", ghazir: "Keserwan",
  ghosta: "Keserwan", harissa: "Keserwan", daraoun: "Keserwan",
  safra: "Keserwan", tabarja: "Keserwan", bouar: "Keserwan",
  kfarhbab: "Keserwan", "kfar hbab": "Keserwan", kfarhabab: "Keserwan",
  kfour: "Keserwan", kfaryassine: "Keserwan", "kfar yassine": "Keserwan",
  kfartai: "Keserwan", jeita: "Keserwan", hrajel: "Keserwan",
  faraya: "Keserwan", faqra: "Keserwan", kfardebiane: "Keserwan",
  kfardebian: "Keserwan", chahtoul: "Keserwan", rayfoun: "Keserwan",
  aintoura: "Keserwan", chnaniir: "Keserwan", gherfine: "Keserwan",
  "sahel aalma": "Keserwan", "haret sakher": "Keserwan",
  "haret sakhr": "Keserwan", "hareth sakhr": "Keserwan",
  "zouq el kharab": "Keserwan", ghineh: "Keserwan", bqaatouta: "Keserwan",

  // ── Jbeil ─────────────────────────────────────────────────────────────────
  jbeil: "Jbeil", jbail: "Jbeil", byblos: "Jbeil", amchit: "Jbeil",
  aamchit: "Jbeil", amshit: "Jbeil", halat: "Jbeil", halate: "Jbeil",
  blat: "Jbeil", berbara: "Jbeil", eddeh: "Jbeil", hbaline: "Jbeil",
  mastita: "Jbeil", hsarat: "Jbeil", ehmej: "Jbeil", jdayel: "Jbeil",
  abaidat: "Jbeil", "nahr ibrahim": "Jbeil", ebreen: "Jbeil",
  habboub: "Jbeil", hboub: "Jbeil", fatreh: "Jbeil", mechan: "Jbeil",
  laqlouq: "Jbeil", aabaidat: "Jbeil",

  // ── Batroun ───────────────────────────────────────────────────────────────
  batroun: "Batroun", "smar jbeil": "Batroun", "smare jbeil": "Batroun",
  "kfar aabida": "Batroun", kfarabida: "Batroun", tannourine: "Batroun",
  chekka: "Batroun", douma: "Batroun", "ras nhach": "Batroun", basbina: "Batroun",
  hamat: "Batroun", kour: "Batroun",

  // ── Koura ─────────────────────────────────────────────────────────────────
  koura: "Koura", amioun: "Koura", kousba: "Koura", "ras maska": "Koura",
  "ras masqa": "Koura", rasmasqa: "Koura", anfeh: "Koura", barsa: "Koura",
  bziza: "Koura", bzeza: "Koura", "dahr el ain": "Koura",
  "daher el ayn": "Koura", fih: "Koura", kfaraaka: "Koura",
  kafaraaka: "Koura", "majdel koura": "Koura", btaaboura: "Koura",
  qalamoun: "Koura", miryata: "Koura", btouraam: "Koura", btorram: "Koura",
  bkeftine: "Koura", kelhat: "Koura",

  // ── Tripoli ───────────────────────────────────────────────────────────────
  tripoli: "Tripoli", trablous: "Tripoli", طرابلس: "Tripoli", mina: "Tripoli",
  beddawi: "Tripoli", baddawi: "Tripoli", "abou samra": "Tripoli",
  qobbe: "Tripoli", zahrieh: "Tripoli",

  // ── Zgharta ───────────────────────────────────────────────────────────────
  zgharta: "Zgharta", ehden: "Zgharta", miziara: "Zgharta",
  "karm saddeh": "Zgharta", kferhata: "Zgharta", kfarhata: "Zgharta",
  asnoun: "Zgharta", aslout: "Zgharta", rachiine: "Zgharta",

  // ── Bsharri ───────────────────────────────────────────────────────────────
  bsharri: "Bsharri", bcharre: "Bsharri", bsharre: "Bsharri",
  becharre: "Bsharri", hasroun: "Bsharri", bqaakafra: "Bsharri",
  bekasfrine: "Bsharri", "hadat el jebbeh": "Bsharri", "hadeth el jebbeh": "Bsharri",

  // ── Minieh-Danniyeh ───────────────────────────────────────────────────────
  miniyeh: "Minieh-Danniyeh", minieh: "Minieh-Danniyeh",
  danniyeh: "Minieh-Danniyeh", الضنية: "Minieh-Danniyeh",
  sir: "Minieh-Danniyeh", bqarsouna: "Minieh-Danniyeh",

  // ── Akkar ─────────────────────────────────────────────────────────────────
  akkar: "Akkar", akar: "Akkar", halba: "Akkar", qoubaiyat: "Akkar",
  kobayat: "Akkar", aandqet: "Akkar", aabdeh: "Akkar", "beir el ahmar": "Akkar",
  bebnine: "Akkar", "cheikh taba": "Akkar",

  // ── Zahle ─────────────────────────────────────────────────────────────────
  zahle: "Zahle", zahleh: "Zahle", chtoura: "Zahle", chtaura: "Zahle",
  saadnayel: "Zahle", saadneyl: "Zahle", "qob elias": "Zahle",
  "qab elias": "Zahle", "bar elias": "Zahle", ksara: "Zahle", ferzol: "Zahle",
  "ali el nahri": "Zahle", "nabi ayla": "Zahle", taanayel: "Zahle",
  riyaq: "Zahle", "deir el ghazal": "Zahle", "kfar zabad": "Zahle",
  haouch: "Zahle", "haouch el oumaraa": "Zahle", "haouch el omara": "Zahle",
  terbol: "Zahle", ablah: "Zahle",

  // ── West Bekaa ────────────────────────────────────────────────────────────
  "west bekaa": "West Bekaa", "jeb jenine": "West Bekaa",
  "joub jannine": "West Bekaa", "kamed el laouz": "West Bekaa",
  "kamid el loz": "West Bekaa", kefraya: "West Bekaa", saghbine: "West Bekaa",
  aitanit: "West Bekaa", khiara: "West Bekaa", "ain zebde": "West Bekaa",
  machghara: "West Bekaa", "qaraoun": "West Bekaa",

  // ── Rachaya ───────────────────────────────────────────────────────────────
  rachaya: "Rachaya", "kfar mechki": "Rachaya", "kfar mishki": "Rachaya",
  aiha: "Rachaya", "deir el ashayer": "Rachaya",

  // ── Baalbek / Hermel ──────────────────────────────────────────────────────
  baalbek: "Baalbek", baalbeck: "Baalbek", douris: "Baalbek",
  aarsal: "Baalbek", "deir el ahmar": "Baalbek", chmestar: "Baalbek",
  britel: "Baalbek", hermel: "Hermel",

  // ── Saida ─────────────────────────────────────────────────────────────────
  saida: "Saida", sidon: "Saida", "haret saida": "Saida", ghaziyeh: "Saida",
  ghazzieh: "Saida", abra: "Saida", sarafand: "Saida", aanqoun: "Saida",
  bqosta: "Saida", zaghdraiya: "Saida", tanbourit: "Saida",
  "kfar hatta": "Saida", "kfar hitta": "Saida", miye: "Saida",
  hlaliyeh: "Saida", ansariyeh: "Saida",

  // ── Jezzine ───────────────────────────────────────────────────────────────
  jezzine: "Jezzine", bkassine: "Jezzine", lebaa: "Jezzine",
  "kfar houne": "Jezzine", roum: "Jezzine", aaray: "Jezzine",

  // ── Sour ──────────────────────────────────────────────────────────────────
  sour: "Sour", tyre: "Sour", "el buss": "Sour", bazouriye: "Sour",
  "ain baal": "Sour", hanouiyeh: "Sour", "majdal zoun": "Sour",
  "tayr felsar": "Sour", aaqbiyeh: "Sour", qana: "Sour", maarake: "Sour",
  "safad el battikh": "Bint Jbeil", bourghliye: "Sour", rachidieh: "Sour",

  // ── Nabatieh ──────────────────────────────────────────────────────────────
  nabatieh: "Nabatieh", النبطية: "Nabatieh", jibchit: "Nabatieh",
  jibsheet: "Nabatieh", doueir: "Nabatieh", "kfar roummane": "Nabatieh",
  habbouch: "Nabatieh", zibdine: "Nabatieh", arabsalim: "Nabatieh",
  houmine: "Nabatieh", zawtar: "Nabatieh",

  // ── Bint Jbeil / Marjeyoun / Hasbaya ──────────────────────────────────────
  "bint jbeil": "Bint Jbeil", aitaroun: "Bint Jbeil", tebnine: "Bint Jbeil",
  ainata: "Bint Jbeil", marjeyoun: "Marjeyoun", khiam: "Marjeyoun",
  "kfar kila": "Marjeyoun", hasbaya: "Hasbaya", hasbaiyya: "Hasbaya",
  shwaya: "Hasbaya", chouaya: "Hasbaya", "kfar hamam": "Hasbaya",

  // ── Aley ──────────────────────────────────────────────────────────────────
  aley: "Aley", alay: "Aley", aalay: "Aley", bhamdoun: "Aley",
  aramoun: "Aley", aaramoun: "Aley", aramoune: "Aley", aramon: "Aley",
  bchamoun: "Aley", bshamun: "Aley", bshemon: "Aley", bshemun: "Aley",
  choueifat: "Aley", chouaifet: "Aley", chwayfet: "Aley",
  "ash shuwayfat": "Aley", shuwayfat: "Aley", khalde: "Aley",
  "ain aanoub": "Aley", "ain anoub": "Aley", aitat: "Aley", aaitat: "Aley",
  "souk el gharb": "Aley", chartoun: "Aley", qmatiyeh: "Aley", bsous: "Aley",
  ainab: "Aley", kahale: "Aley", baawerta: "Aley", houmal: "Aley",
  "qabr chamoun": "Aley", qabrshmoun: "Aley", remhala: "Aley", btater: "Aley",
  saoufar: "Aley", sofar: "Aley", "ain dara": "Aley", bleibel: "Aley",
  blaybel: "Aley", aabey: "Aley", chanay: "Aley",

  // ── Chouf ─────────────────────────────────────────────────────────────────
  chouf: "Chouf", shouf: "Chouf", shuf: "Chouf", baakleen: "Chouf",
  baakline: "Chouf", "deir el qamar": "Chouf", barja: "Chouf", jiyeh: "Chouf",
  jieh: "Chouf", dibbiyeh: "Chouf", damour: "Chouf", naameh: "Chouf",
  baasir: "Chouf", dmit: "Chouf", "kfar nabrakh": "Chouf", aanout: "Chouf",
  "ain zhalta": "Chouf", chehime: "Chouf", jadra: "Chouf", mazboud: "Chouf",
  semqanieh: "Chouf", moukhtara: "Chouf", joun: "Chouf", joune: "Chouf",
  rmeileh: "Chouf", daraya: "Chouf", darayaa: "Chouf", baakata: "Chouf",
  boqaata: "Chouf", bakaata: "Chouf", ketermaya: "Chouf", barouk: "Chouf",
};

// Strings that look like a place but are not — checkout noise, placeholder
// values, governorate names too coarse to be an area. Listed explicitly so
// they resolve to null immediately instead of being fuzzy-matched onto some
// unlucky town with a similar spelling.
const NOT_A_PLACE = new Set([
  "", "0", "lebanon", "liban", "mount lebanon", "mountlebanon", "mont liban",
  "jabal lebanon", "jabal lebnen", "north lebanon", "south lebanon", "bekaa",
  "beka", "el bekaa", "choose your city", "mt", "tr", "na", "n a", "none",
  "test", "string", "beirut suburbs",
]);

// Longest keys first so specific entries beat generic ones during the
// whole-word scan: "ras el metn" (Baabda) must win over "metn" (Metn).
const SORTED_TOWNS = Object.keys(TOWN_TO_AREA).sort((a, b) => b.length - a.length);

// Lowercases, strips accents, drops punctuation and collapses whitespace, so
// "Zahlé", "ZAHLE " and "Zahle," all reduce to the same key. Arabic letters are
// preserved — a handful of orders arrive with Arabic-only city names.
function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents left by NFD
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ") // keep latin, digits, Arabic
    .trim()
    .replace(/\s+/g, " ");
}

// Standard Levenshtein distance, capped: we bail out as soon as the best
// possible result exceeds maxDistance, which keeps the fuzzy pass cheap even
// though it runs against every table key.
function editDistance(a, b, maxDistance) {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
      if (current[j] < rowBest) rowBest = current[j];
    }

    if (rowBest > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[b.length];
}

// True when `town` appears in `city` on whole-word boundaries, so "adma" hits
// "adma kesrwan" but "abra" does not hit "abraham".
function containsWord(city, town) {
  const index = city.indexOf(town);
  if (index === -1) return false;

  const before = index === 0 ? " " : city[index - 1];
  const afterIndex = index + town.length;
  const after = afterIndex >= city.length ? " " : city[afterIndex];

  return before === " " && after === " ";
}

// Resolves a raw city string to the town key it matches in TOWN_TO_AREA, or
// null when nothing matches. This is the actual matcher; resolveArea is a thin
// wrapper over it.
//
// The town key matters on its own because it is finer-grained than the area:
// Amchit and Jbeil are both "Jbeil" as an area, but they are a 10-minute drive
// apart, so the ETA calculation resolves the town and looks its coordinates up
// in town-coords.json rather than settling for the caza.
function resolveTown(city) {
  const normalized = normalize(city);
  if (!normalized || NOT_A_PLACE.has(normalized)) return null;

  // 1. Exact match — the common case for clean city values.
  if (TOWN_TO_AREA[normalized]) return normalized;

  // 2. Whole-word match, longest key first. This is what rescues the long tail
  //    of "<town> + extra words" strings that make up most of the history.
  for (const town of SORTED_TOWNS) {
    if (town.length < 4) continue; // too short to match safely inside a sentence
    if (containsWord(normalized, town)) return town;
  }

  // 3. Fuzzy match for typos, single-word inputs only. Multi-word strings are
  //    excluded because step 2 already had its chance and fuzzy-matching a long
  //    address against short town names produces nonsense.
  //
  //    Distance is capped at 1, deliberately. An earlier version allowed 2 for
  //    longer words and silently filed "Awkar" (Metn) under "Akkar" — a town
  //    100 km away. One edit is enough for real typos ("Beirur", "Beurut");
  //    anything looser starts inventing matches. Known variants that need more
  //    than one edit belong in the table above as explicit keys.
  if (!normalized.includes(" ") && normalized.length >= 5) {
    const maxDistance = 1;
    let best = null;
    let bestDistance = maxDistance + 1;

    for (const town of SORTED_TOWNS) {
      if (town.includes(" ")) continue;
      const distance = editDistance(normalized, town, maxDistance);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = town;
        if (distance === 0) break;
      }
    }

    if (best && bestDistance <= maxDistance) return best;
  }

  return null;
}

// Resolves a raw city string to an area name, or null when nothing matches.
// Callers store null as UNKNOWN_AREA ("Other").
function resolveArea(city) {
  const town = resolveTown(city);
  return town ? TOWN_TO_AREA[town] : null;
}

// Convenience wrapper for write paths: always returns a storable string.
function resolveAreaOrUnknown(city) {
  return resolveArea(city) || UNKNOWN_AREA;
}

module.exports = {
  AREAS,
  UNKNOWN_AREA,
  TOWN_TO_AREA,
  normalize,
  resolveTown,
  resolveArea,
  resolveAreaOrUnknown,
};
