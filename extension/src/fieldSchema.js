// Single source of truth for the canonical field names produced by parseFields.js.
//
// When building a new Word template, only use the `key` value below inside {{ }} (lowercase
// snake_case, e.g. {{business_name}}) or one of its `aliases` -- that's what keeps every bundled
// template pulling from the same extracted data instead of each one inventing its own spelling
// ("Tarriff Name", "[X:Unlimited]", ...), which is how parseFields.js ended up with a pile of
// one-off alias hacks. Add a new entry here when a template needs a genuinely new value; add an
// alias here (not a hardcoded map elsewhere) when a template just spells an existing field
// differently.
const FIELD_SCHEMA = [
  { key: 'business_name', description: 'Customer / company name.', aliases: ['customer_name', 'full_name', 'name', 'customer'] },
  { key: 'address_first_line', description: 'Billing address line 1.', aliases: ['address_line_1'] },
  { key: 'address_second_line', description: 'Billing address line 2.', aliases: ['address_line_2'] },
  { key: 'address_third_line', description: 'Billing address line 3 (remaining town/county lines, joined).', aliases: ['address_line_3'] },
  { key: 'post_code', description: 'Billing postcode, e.g. TR6 0DF.', aliases: ['postal_code'] },
  { key: 'customer_full_address', description: 'All billing address lines + postcode joined into one string.', aliases: ['full_address', 'address', 'customer_address'] },
  { key: 'consumer_plan', description: 'Plan / tariff name, with the price stripped off.', aliases: ['plan', 'product', 'tariff', 'tariff_name', 'tarriff', 'tarriff_name'] },
  { key: 'price', description: 'Bare monthly price number, no currency symbol (template supplies the £).', aliases: ['monthly_price', 'price_per', 'cost'] },
  { key: 'data_allowance', description: 'Data cap as a plain number of GB, or the word "Unlimited".', aliases: ['x_unlimited', 'data', 'data_bundle', 'gb', 'allowance'] },
  { key: 'email_address', description: 'Customer email address.', aliases: ['email'] },
  { key: 'mobile_number', description: 'Customer mobile number.', aliases: ['mobile', 'phone_number'] },
  { key: 'quote_id', description: 'CRM quote / order ID.', aliases: ['quoteid'] },
  { key: 'pac_code', description: 'Porting authorisation code.', aliases: ['pac'] },
  { key: 'porting_number', description: 'Number being ported in from the customer\'s old network.', aliases: ['porting_mpn', 'mpn', 'port_number'] },
  { key: 'spend_cap', description: 'Spend cap set on the account.', aliases: [] },
  { key: 'bank_name', description: 'Bank name, parsed from Special Requirements.', aliases: ['bank'] },
  { key: 'sort_code', description: 'Bank sort code.', aliases: [] },
  { key: 'account_number', description: 'Bank account number.', aliases: [] },
  { key: 'date_of_birth', description: 'Customer date of birth, UK format dd/mm/yyyy.', aliases: ['dob'] },
  { key: 'agent_name', description: 'Sales agent name.', aliases: ['agent'] },
  { key: 'eligibility_date', description: 'Eligibility date field from the page.', aliases: [] },
  { key: 'sale_type', description: 'Sale type, e.g. "EE Consumer".', aliases: [] },
  { key: 'monthly_line_rental', description: 'Monthly line rental charge.', aliases: ['monthly_rental', 'line_rental'] },
  { key: 'contract_term', description: 'Contract length, e.g. "24 Months".', aliases: ['minimum_term', 'contract_length'] },
  { key: 'todays_date', description: "Today's date (UK format) at the moment the document is generated.", aliases: ['date', 'today_date'] },
  { key: 'now_datetime', description: 'Current date + time (UK format) at the moment the document is generated.', aliases: ['now', 'generated', 'generated_date', 'timestamp'] },
];

if (typeof window !== 'undefined') {
  window.FieldSchema = FIELD_SCHEMA;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FIELD_SCHEMA;
}
