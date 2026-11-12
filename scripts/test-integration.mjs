import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Only containers created by this invocation are removed. No Compose/user volumes.
const suffix = randomUUID().slice(0, 12);
const containers = [];
const env = { ...process.env, NODE_ENV: 'test' };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 180_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ''} failed: ${result.stderr || result.error?.message || 'nonzero exit'}`,
    );
  }
  return result.stdout?.trim() ?? '';
}
async function start(service, image, args, probe) {
  const name = `antriin-test-${service}-${suffix}`;
  run('docker', ['run', '--rm', '-d', '--name', name, ...args, image]);
  containers.push(name);
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = spawnSync('docker', ['exec', name, ...probe], {
      stdio: 'ignore',
    });
    if (result.status === 0) return name;
    await delay(250);
  }
  throw new Error(`${service} test container did not become ready`);
}
try {
  const pg = await start(
    'postgres',
    'postgres:17-alpine',
    [
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      'POSTGRES_USER=antriin_test',
      '-e',
      'POSTGRES_PASSWORD=ephemeral_test_only',
      '-e',
      'POSTGRES_DB=antriin_test',
      '-p',
      '127.0.0.1::5432',
    ],
    ['pg_isready', '-U', 'antriin_test', '-d', 'antriin_test'],
  );
  const redis = await start(
    'redis',
    'redis:7-alpine',
    ['-p', '127.0.0.1::6379'],
    ['redis-cli', 'ping'],
  );
  const port = run('docker', ['port', pg, '5432/tcp']).split(':').at(-1);
  const redisPort = run('docker', ['port', redis, '6379/tcp'])
    .split(':')
    .at(-1);
  env.DATABASE_URL = `postgresql://antriin_test:ephemeral_test_only@127.0.0.1:${port}/antriin_test`;
  env.TEST_DATABASE_URL = env.DATABASE_URL;
  env.REDIS_HOST = '127.0.0.1';
  env.REDIS_PORT = redisPort;
  env.TEST_REDIS_PORT = redisPort;
  env.CORS_ORIGINS = 'http://localhost:3001';
  run('npm', ['run', 'db:migrate'], { env, stdio: 'inherit' });
  run('npm', ['test'], { env, stdio: 'inherit' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) {
    spawnSync('docker', ['stop', '--time', '3', name], { stdio: 'ignore' });
  }
}
