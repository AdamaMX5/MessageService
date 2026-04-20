const axios = require('axios');
const jwt = require('jsonwebtoken');

let cachedPublicKey = null;

async function fetchPublicKey() {
  const url = `${process.env.AUTH_URL}/jwt/public-key`;
  console.log(`[jwtService] Fetching public key from ${url}`);
  const { data } = await axios.get(url);
  console.log(`[jwtService] Raw response keys: ${Object.keys(data).join(', ')}`);

  // AuthService returns { status, algorithm, public_key }
  if (typeof data === 'string') {
    cachedPublicKey = data;
  } else if (data.public_key) {
    cachedPublicKey = data.public_key;
  } else if (data.publicKey) {
    cachedPublicKey = data.publicKey;
  } else {
    console.error('[jwtService] Unexpected public key response:', JSON.stringify(data));
    throw new Error('Could not extract public key from AuthService response');
  }

  console.log(`[jwtService] Public key loaded (first 60 chars): ${cachedPublicKey.slice(0, 60)}`);
  return cachedPublicKey;
}

async function getPublicKey() {
  if (!cachedPublicKey) {
    await fetchPublicKey();
  }
  return cachedPublicKey;
}

async function refreshPublicKey() {
  return fetchPublicKey();
}

function verifyToken(token) {
  if (!cachedPublicKey) {
    console.error('[jwtService] verifyToken called but public key is not loaded');
    throw new Error('Public key not loaded yet');
  }
  try {
    const decoded = jwt.decode(token, { complete: true });
    console.log(`[jwtService] Verifying token — alg: ${decoded?.header?.alg}, sub: ${decoded?.payload?.sub}, exp: ${decoded?.payload?.exp ? new Date(decoded.payload.exp * 1000).toISOString() : 'n/a'}`);
    return jwt.verify(token, cachedPublicKey, { algorithms: ['RS256'] });
  } catch (err) {
    console.error(`[jwtService] Token verification failed: ${err.message}`);
    throw err;
  }
}

module.exports = { getPublicKey, refreshPublicKey, verifyToken };
