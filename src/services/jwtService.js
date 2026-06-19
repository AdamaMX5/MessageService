const axios = require('axios');
const jwt = require('jsonwebtoken');

let cachedPublicKey = null;

async function fetchPublicKey() {
  const url = `${process.env.AUTH_URL}/jwt/public-key`;
  console.log(`[jwtService] Fetching public key from ${url}`);
  const { data } = await axios.get(url);

  // AuthService returns { status, algorithm, public_key }
  if (typeof data === 'string') {
    cachedPublicKey = data;
  } else if (data.public_key) {
    cachedPublicKey = data.public_key;
  } else if (data.publicKey) {
    cachedPublicKey = data.publicKey;
  } else {
    // Log only the shape, never the payload, of an unexpected response.
    console.error(`[jwtService] Unexpected public key response shape: ${Object.keys(data).join(', ')}`);
    throw new Error('Could not extract public key from AuthService response');
  }

  console.log('[jwtService] Public key loaded');
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
    // Algorithm is pinned to RS256 to prevent alg-confusion (e.g. alg:none / HS256).
    // We never log decoded claims — `sub` and friends are sensitive at request volume.
    return jwt.verify(token, cachedPublicKey, { algorithms: ['RS256'] });
  } catch (err) {
    console.error(`[jwtService] Token verification failed: ${err.message}`);
    throw err;
  }
}

module.exports = { getPublicKey, refreshPublicKey, verifyToken };
