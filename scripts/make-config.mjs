// Copies the public Supabase values from .env into config.js.
// Run from the project folder: node scripts/make-config.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const url = env.SUPABASE_URL;
const key = env.SUPABASE_ANON_KEY;
if (!url || !key || url.includes('your-project')) {
  console.error('Fill in SUPABASE_URL and SUPABASE_ANON_KEY in .env first.');
  process.exit(1);
}
// Legacy keys are JWTs; the middle part says which role the key has.
let role = null;
try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch {}
if (key.startsWith('sb_secret_') || role === 'service_role' || key === env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('That is the secret service_role key. Use the anon public key for the website.');
  process.exit(1);
}
if (role !== 'anon') {
  console.error('That doesn\'t look like the anon key. Copy "anon public" from Legacy API keys.');
  process.exit(1);
}

writeFileSync(new URL('../config.js', import.meta.url), `// Generated from .env by scripts/make-config.mjs. Edit .env, not this file.
// The anon key is meant to be public. Row level security in schema.sql keeps the data safe.
window.CREW_CONFIG = {
  url: '${url}',
  anonKey: '${key}',
};
`);
console.log('config.js updated');
