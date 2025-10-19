// Division 23 (HVAC) canonical scope dictionary with synonyms
export type CanonicalItem = {
  name: string;
  synonyms: string[];
};

export const DIV23_SCOPE: CanonicalItem[] = [
  { name: 'HVAC equipment', synonyms: ['ahu', 'air handling unit', 'air handler', 'hvac unit', 'package unit', 'rooftop unit', 'rtu', 'fan coil', 'heat pump', 'condensing unit'] },
  { name: 'VRF/VRV system', synonyms: ['vrf', 'vrv', 'variable refrigerant', 'multi split'] },
  { name: 'Ductwork', synonyms: ['duct', 'ducting', 'sheet metal'] },
  { name: 'Air distribution', synonyms: ['diffuser', 'register', 'grille', 'vav', 'variable air volume', 'terminal unit'] },
  { name: 'Temperature controls', synonyms: ['controls', 'bms', 'ddc', 'thermostat', 'building automation'] },
  { name: 'Testing & balancing', synonyms: ['testing and balancing', 'tab', 'air balance', 'water balance'] },
  { name: 'Mechanical insulation', synonyms: ['insulation', 'duct wrap', 'pipe insulation'] },
  { name: 'Condensate piping', synonyms: ['condensate', 'condensate drain'] },
  { name: 'Refrigerant piping', synonyms: ['refrigerant piping', 'line set', 'lineset'] },
  { name: 'Controls integration', synonyms: ['controls integration', 'bms integration'] },
  { name: 'Demolition', synonyms: ['demo', 'remove existing', 'removal of existing'] },
  { name: 'Crane & rigging', synonyms: ['crane', 'rigging', 'hoisting'] },
  { name: 'Startup & commissioning', synonyms: ['startup', 'start up', 'commissioning'] },
  { name: 'Shop drawings', synonyms: ['shop drawing', 'submittal', 'submittals'] },
  { name: 'Title 24 documentation', synonyms: ['title 24', 'energy compliance', 'comcheck'] },
  { name: 'Seismic bracing', synonyms: ['seismic', 'seismic restraints', 'restraint'] },
  { name: 'BIM/3D coordination', synonyms: ['bim', '3d coordination', 'navisworks', 'clash detection'] },
  { name: 'Permits & inspections', synonyms: ['permit', 'inspection', 'ahj'] },
  { name: 'Controls programming', synonyms: ['controls programming', 'sequence of operations'] },
];

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s\.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildSynonymIndex(dict: CanonicalItem[]) {
  const idx: Record<string, string> = {};
  for (const item of dict) {
    idx[normalize(item.name)] = item.name;
    for (const s of item.synonyms) idx[normalize(s)] = item.name;
  }
  return idx;
}

export function canonize(dictIdx: Record<string, string>, phrase: string): string | null {
  const n = normalize(phrase);
  // exact or contained match in synonym index
  if (dictIdx[n]) return dictIdx[n];
  // try to find any synonym token contained in phrase
  for (const key of Object.keys(dictIdx)) {
    if (n.includes(key) && key.length >= 3) return dictIdx[key];
  }
  return null;
}
