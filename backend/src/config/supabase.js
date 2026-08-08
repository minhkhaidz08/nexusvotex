const { createClient } = require('@supabase/supabase-js');

// The .env.example placeholders are truthy, so they would pass the "missing"
// check above and crash supabase-js with "Invalid supabaseUrl". Treat any
// placeholder value as unset and fall back to the local Supabase defaults so
// the server still boots and logs a clear warning.
const PLACEHOLDER = /your_|change_this/i;

function effective(value, fallback) {
  if (!value || PLACEHOLDER.test(value)) return fallback;
  return value;
}

const supabaseUrl = effective(process.env.SUPABASE_URL, 'https://rpnautoxqxduftrtgvkr.supabase.co');
const supabaseAnonKey = effective(process.env.SUPABASE_ANON_KEY, 'no-key');
const supabaseServiceKey = effective(process.env.SUPABASE_SERVICE_ROLE_KEY, 'no-key');

if (supabaseServiceKey === 'no-key') {
  console.warn(
    '[NexusVotex] Supabase credentials not configured. Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env - the API will not work.'
  );
}

// Service role client - bypasses RLS, used server-side only. NEVER expose to frontend.
const admin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client for public reads (products, news, settings)
const anon = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { admin, anon };
