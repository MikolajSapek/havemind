import { cp } from 'node:fs/promises';

const source = new URL('../src/migrations/', import.meta.url);
const destination = new URL('../dist/migrations/', import.meta.url);

await cp(source, destination, { force: true, recursive: true });
