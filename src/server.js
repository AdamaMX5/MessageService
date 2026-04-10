require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const { getPublicKey } = require('./services/jwtService');

const PORT = process.env.PORT || 3006;

async function start() {
  await connectDB();

  // Fetch the JWT public key once on startup so all subsequent requests
  // can verify tokens without a round-trip to the AuthService.
  await getPublicKey();

  app.listen(PORT, () => {
    console.log(`MessageService running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
