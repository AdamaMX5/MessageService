const mongoose = require('mongoose');

// Defense-in-depth against NoSQL operator injection: wraps user-supplied filter
// values so that an object like { $ne: null } is treated as a literal, not an
// operator. Applies to every Mongoose query in the service.
mongoose.set('sanitizeFilter', true);

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');
}

module.exports = connectDB;
