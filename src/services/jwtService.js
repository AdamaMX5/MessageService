const axios = require('axios');
const jwt = require('jsonwebtoken');

let cachedPublicKey = null;

async function fetchPublicKey() {
  const url = `${process.env.AUTH_URL}/jwt/public-key`;
  const { data } = await axios.get(url);
  cachedPublicKey = typeof data === 'string' ? data : data.publicKey;
  console.log('JWT public key refreshed');
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
  if (!cachedPublicKey) throw new Error('Public key not loaded yet');
  return jwt.verify(token, cachedPublicKey, { algorithms: ['RS256'] });
}

module.exports = { getPublicKey, refreshPublicKey, verifyToken };
