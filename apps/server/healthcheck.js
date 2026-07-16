// Container HEALTHCHECK probe. Exits 0 when /healthz answers 200, else 1.
// Uses only the Node standard library so it runs in the hardened runtime image.
import { get } from 'node:http';

const port = Number.parseInt(process.env.HAVEMIND_PORT ?? '8787', 10);
const host = '127.0.0.1';

const request = get(
  { host, port, path: '/healthz', timeout: 4000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});

request.on('error', () => {
  process.exit(1);
});
