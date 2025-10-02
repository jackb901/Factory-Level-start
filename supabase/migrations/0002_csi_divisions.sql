-- CSI divisions reference and optional link from bids

create table if not exists public.csi_divisions (
  code text primary key,
  name text not null
);

-- Seed standard CSI divisions (01–49; subset with common modern divisions)
insert into public.csi_divisions (code, name) values
  ('01', 'General Requirements'),
  ('02', 'Existing Conditions'),
  ('03', 'Concrete'),
  ('04', 'Masonry'),
  ('05', 'Metals'),
  ('06', 'Wood, Plastics, and Composites'),
  ('07', 'Thermal and Moisture Protection'),
  ('08', 'Openings'),
  ('09', 'Finishes'),
  ('10', 'Specialties'),
  ('11', 'Equipment'),
  ('12', 'Furnishings'),
  ('13', 'Special Construction'),
  ('14', 'Conveying Equipment'),
  ('21', 'Fire Suppression'),
  ('22', 'Plumbing'),
  ('23', 'Heating, Ventilating, and Air Conditioning (HVAC)'),
  ('25', 'Integrated Automation'),
  ('26', 'Electrical'),
  ('27', 'Communications'),
  ('28', 'Electronic Safety and Security'),
  ('31', 'Earthwork'),
  ('32', 'Exterior Improvements'),
  ('33', 'Utilities'),
  ('34', 'Transportation'),
  ('35', 'Waterway and Marine'),
  ('40', 'Process Integration'),
  ('41', 'Material Processing and Handling Equipment'),
  ('42', 'Process Heating, Cooling, and Drying Equipment'),
  ('43', 'Process Gas and Liquid Handling, Purification and Storage Equipment'),
  ('44', 'Pollution Control Equipment'),
  ('45', 'Industry-Specific Manufacturing Equipment'),
  ('46', 'Water and Wastewater Equipment'),
  ('48', 'Electrical Power Generation')
on conflict (code) do nothing;

-- Optional link from bids → csi_divisions
alter table public.bids add column if not exists division_code text references public.csi_divisions(code);
