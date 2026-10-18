export type AllergySynonymGroup = {
  key: string;
  synonyms: string[];
};

export const ALLERGY_SYNONYM_GROUPS: AllergySynonymGroup[] = [
  {
    key: "penicillin",
    synonyms: [
      "penicillin",
      "penicillins",
      "amoxicillin",
      "amoxycillin",
      "ampicillin",
      "piperacillin",
      "ticarcillin",
      "dicloxacillin",
      "oxacillin",
      "nafcillin",
      "flucloxacillin",
      "co-amoxiclav",
      "amoxicillin-clavulanate",
      "augmentin",
    ],
  },
  {
    key: "sulfa",
    synonyms: [
      "sulfa",
      "sulpha",
      "sulfonamide",
      "sulphonamide",
      "sulfamethoxazole",
      "trimethoprim-sulfamethoxazole",
      "cotrimoxazole",
      "bactrim",
      "septra",
      "sulfasalazine",
      "dapsone",
    ],
  },
  {
    key: "aspirin",
    synonyms: ["aspirin", "acetylsalicylic acid", "asa"],
  },
  {
    key: "nsaids",
    synonyms: [
      "nsaid",
      "nsaids",
      "nonsteroidal anti-inflammatory",
      "non-steroidal anti-inflammatory",
      "ibuprofen",
      "naproxen",
      "diclofenac",
      "ketoprofen",
      "indomethacin",
      "piroxicam",
      "celecoxib",
      "etoricoxib",
      "meloxicam",
      "mefenamic acid",
      "flurbiprofen",
    ],
  },
];

export function buildAllergyMatcher() {
  const map = new Map<string, string>();
  for (const g of ALLERGY_SYNONYM_GROUPS) {
    for (const s of g.synonyms) map.set(s.toLowerCase().trim(), g.key);
    map.set(g.key.toLowerCase(), g.key);
  }
  return map;
}