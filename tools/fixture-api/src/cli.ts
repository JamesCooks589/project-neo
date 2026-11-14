import { startFixture } from './index';

async function main() {
  const value = process.env.NEO_FIXTURE_PORT ?? '4317';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('NEO_FIXTURE_PORT must be between 0 and 65535.');
  const fixture = await startFixture({ port });
  console.log('Project Neo fixture API listening at ' + fixture.baseUrl);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void fixture.close().catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
