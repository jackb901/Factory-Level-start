export type LevelInput = {
  raw_text: string | null;
  qty: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
};

export type LevelOutput = {
  canonical_name: string | null;
  qty: number | null;
  unit: string | null;
  unit_cost: number | null;
  total: number | null;
};

const UNIT_MAP: Record<string, string> = {
  sf: 'SF', 'sqft': 'SF', 'squarefeet': 'SF', 'squarefoot': 'SF',
  sy: 'SY', 'sqyd': 'SY', 'squareyards': 'SY',
  lf: 'LF', 'lft': 'LF', 'linearfeet': 'LF',
  ea: 'EA', 'each': 'EA', 'cnt': 'EA', 'count': 'EA',
  ls: 'LS', 'lumpsum': 'LS', 'lump': 'LS',
  hr: 'HR', 'hrs': 'HR', 'hour': 'HR', 'hours': 'HR',
  cy: 'CY', 'cuyd': 'CY', 'cubicyards': 'CY',
  cf: 'CF', 'cuydft': 'CF', 'cubicfeet': 'CF',
};

const CANON_RULES: Array<{name: string; patterns: RegExp[]}> = [
  { name: 'Concrete', patterns: [/\bconcrete\b/i, /\bslab\b/i, /\bfooting\b/i] },
  { name: 'Masonry', patterns: [/\bmasonry\b/i, /\bcmu\b/i, /\bbrick\b/i] },
  { name: 'Metals', patterns: [/\bsteel\b/i, /\bmetal\b/i, /\bhandrail\b/i] },
  { name: 'Rough Carpentry', patterns: [/\bframing\b/i, /\bcarpentry\b/i, /\bstud\b/i] },
  { name: 'Drywall & Ceilings', patterns: [/\bdrywall\b/i, /\bgypsum\b/i, /\bceiling\b/i] },
  { name: 'Doors & Windows', patterns: [/\bdoor\b/i, /\bwindow\b/i, /\bglaz/i] },
  { name: 'Flooring', patterns: [/\bfloor\b/i, /\bcarpet\b/i, /\bvinyl\b/i, /\btile\b/i] },
  { name: 'Painting', patterns: [/\bpaint\b/i, /\bcoating\b/i] },
  { name: 'Roofing', patterns: [/\broof\b/i, /\bshingle\b/i, /\bmembrane\b/i] },
  { name: 'Plumbing', patterns: [/\bplumb\b/i, /\bpiping\b/i, /\bfixture\b/i] },
  { name: 'HVAC', patterns: [/\bhvac\b/i, /\bduct\b/i, /\bair\s*handler/i, /\bchiller\b/i] },
  { name: 'Electrical', patterns: [/\belectrical\b/i, /\breceptacle\b/i, /\blighting\b/i, /\bpanel\b/i] },
  { name: 'Fire Protection', patterns: [/\bfire\s*(sprink|suppression)\b/i] },
  { name: 'Earthwork', patterns: [/\bearthwork\b/i, /\bexcavat/i, /\bgrading\b/i] },
];

function normalizeUnit(unit: string | null): string | null {
  if (!unit) return null;
  const key = unit.toLowerCase().replace(/[^a-z]/g, '');
  return UNIT_MAP[key] || unit.toUpperCase();
}

function canonicalFromText(text: string | null): string | null {
  if (!text) return null;
  for (const rule of CANON_RULES) {
    if (rule.patterns.some(p => p.test(text))) return rule.name;
  }
  return null;
}

export function levelItem(input: LevelInput): LevelOutput {
  const unit = normalizeUnit(input.unit);
  const canonical = canonicalFromText(input.raw_text);
  let total = input.total;
  if ((total === null || total === undefined) && input.qty !== null && input.unit_cost !== null) {
    total = Number((input.qty * input.unit_cost).toFixed(2));
  }
  return {
    canonical_name: canonical,
    qty: input.qty,
    unit,
    unit_cost: input.unit_cost,
    total,
  };
}
