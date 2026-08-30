const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'wedding';

if (!uri) {
  console.warn('MONGODB_URI environment variable is not set.');
}

// Reuse the MongoDB connection across serverless function invocations
// to avoid exhausting connections on Vercel's Lambda environment.
let cachedClient = global._mongoClient;
let cachedClientPromise = global._mongoClientPromise;

function getClientPromise() {
  if (cachedClientPromise) return cachedClientPromise;

  const client = new MongoClient(uri, {
    maxPoolSize: 5,
  });

  cachedClientPromise = client.connect();
  global._mongoClient = client;
  global._mongoClientPromise = cachedClientPromise;

  return cachedClientPromise;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(dbName);
}

module.exports = { getDb };
