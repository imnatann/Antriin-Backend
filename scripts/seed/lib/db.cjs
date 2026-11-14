'use strict';

const { Client } = require('pg');

function connectionConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return { connectionString: env.DATABASE_URL };
}

async function withTransaction(work) {
  const client = new Client(connectionConfig());
  await client.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = { withTransaction };
