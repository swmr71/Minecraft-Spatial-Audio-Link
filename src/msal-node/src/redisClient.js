const { createClient } = require('redis');

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379/0' });
redisClient.on('error', (err) => console.error('[Redis] error:', err));

module.exports = redisClient;
