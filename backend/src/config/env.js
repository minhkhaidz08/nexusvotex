function getEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Validate critical env vars at boot so misconfiguration fails loudly
 * instead of crashing mid-request (e.g. jwt.sign with no JWT_SECRET).
 */
function validateEnv() {
  const required = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = required.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(', ')}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    console.warn(`[NexusVotex] ${msg} (continuing in development mode)`);
  }

  const optional = {
    THESIEURE_PARTNER_ID: 'card deposit',
    THESIEURE_PARTNER_KEY: 'card deposit',
    PAYOS_CLIENT_ID: 'bank deposit',
    PAYOS_API_KEY: 'bank deposit',
    PAYOS_CHECKSUM_KEY: 'bank deposit webhook',
  };
  for (const [name, feature] of Object.entries(optional)) {
    if (!process.env[name]) {
      console.warn(`[NexusVotex] ${name} not set - "${feature}" feature will be unavailable`);
    }
  }
}

module.exports = { getEnv, requiredEnv, validateEnv };
