
const { RedisClientSideCache, _waitUntilReady } = require('./lib/RedisClientSideCache');

const ioredis = require('ioredis');

client = new ioredis({
  host: 'localhost',
  port: 6379,
  db: 15 
});

async function init() {
  await _waitUntilReady(client);
    console.log('Redis client is ready');
  let result = await client.set('key', 'value', 'EX', 100);
    console.log('Key set successfully:', result);
}

init().catch(err => {
  console.error('Error initializing Redis client:', err);
});

setTimeout(() => {
  client.get('key', (err, result) => {
    if (err) {
      console.error('Error getting key:', err);
    } else {
      console.log('Value retrieved:', result);
    }
  });
}, 60000);

module.exports = {
  RedisClientSideCache
};

