// Writes the synthetic finance workbook and reconciliation fixture into data/.
import { mkdir, writeFile } from 'node:fs/promises';
import { seedBook } from '../src/domain/seed.js';
import { buildReconFixture } from '../src/recon/fixture.js';
import { writeBook } from '../src/sheet/workbook.js';

await mkdir('data', { recursive: true });
await writeBook('data/finance.xlsx', seedBook);
await writeFile('data/recon.json', `${JSON.stringify(buildReconFixture(), null, 2)}\n`);
console.log('Wrote data/finance.xlsx and data/recon.json');
