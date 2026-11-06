// Replays the whole demo story against an in-memory Airwallex, no keys needed.
//   npm run demo:offline
import { seedBalances, seedRates } from '../src/domain/seed.js';
import { FakeAirwallex } from '../src/airwallex/fake.js';
import { FixtureReader } from '../src/agent/reader.js';
import { AS_OF, runStory } from './story.js';

let minute = 8 * 60 + 15;
const clock = () => {
  minute += 1;
  return `${AS_OF}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`;
};
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const awx = new FakeAirwallex({ ...seedBalances }, seedRates);
await runStory({
  awx,
  reader: new FixtureReader(),
  payLink: async (linkId) => awx.payLink(linkId),
  newId,
  clock,
  outDir: 'out',
});
