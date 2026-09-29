// Run with: npm run discover-fields
// One-off helper to find the real API name of the "Customer Activities"
// field on Deals (custom fields almost never have the api_name you'd guess
// from the display label). Paste the confirmed api_name into .env as
// CUSTOMER_ACTIVITY_FIELD before starting the server.
require('dotenv').config();
const { getDealFieldsMeta } = require('./zohoClient');

(async () => {
  const fields = await getDealFieldsMeta();
  console.log(`Fetched ${fields.length} Deals fields.\n`);

  const hits = fields.filter(f =>
    /activit/i.test(f.field_label || '') || /activit/i.test(f.api_name || '')
  );

  if (!hits.length) {
    console.log('No field with "activity" in its label/api_name was found.');
    console.log('Full field list (label -> api_name):');
    fields.forEach(f => console.log(`  ${f.field_label}  ->  ${f.api_name}  (${f.data_type})`));
    process.exit(1);
  }

  console.log('Candidate "Customer Activities" fields:');
  hits.forEach(f => {
    console.log(`  label: "${f.field_label}"  api_name: "${f.api_name}"  type: ${f.data_type}`);
  });
})().catch(e => {
  console.error('Field discovery failed:', e.message);
  process.exit(1);
});
