-- Contact and address facts the agents put on cover letters, bid emails and
-- portal forms. Like every profile field, empty means MISSING_INFORMATION.
alter table public.company_profiles
  add column trading_name text check (trading_name is null or char_length(trading_name) between 2 and 200),
  add column vat_number text check (vat_number is null or vat_number ~ '^4[0-9]{9}$'),
  add column contact_person text check (contact_person is null or char_length(contact_person) between 2 and 120),
  add column contact_email text check (contact_email is null or (contact_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' and char_length(contact_email) <= 254)),
  add column contact_phone text check (contact_phone is null or contact_phone ~ '^\+?[0-9 ()-]{9,20}$'),
  add column physical_address text check (physical_address is null or char_length(physical_address) between 5 and 500),
  add column postal_address text check (postal_address is null or char_length(postal_address) between 5 and 500),
  add column website text check (website is null or website ~* '^https?://[^\s]{3,200}$');
