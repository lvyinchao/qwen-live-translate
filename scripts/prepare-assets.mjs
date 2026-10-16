import { checkMediaSource } from './check-media-source.mjs';
import fs from 'node:fs/promises';
const mediaSource = await checkMediaSource();
const licenses = {
  'mediabunny-MPL-2.0.txt': 'node_modules/mediabunny/LICENSE',
  'googlevideo-MIT.txt': 'node_modules/googlevideo/LICENSE',
  'react-MIT.txt': 'node_modules/react/LICENSE',
  'react-dom-MIT.txt': 'node_modules/react-dom/LICENSE',
  'scheduler-MIT.txt': 'node_modules/scheduler/LICENSE',
  'lucide-ISC.txt': 'node_modules/lucide-react/LICENSE',
};
await fs.mkdir('public/licenses', { recursive: true });
for (const [name, source] of Object.entries(licenses))
  await fs.copyFile(source, 'public/licenses/' + name);
await fs.copyFile('THIRD_PARTY_NOTICES.md', 'public/THIRD_PARTY_NOTICES.md');
// Auxiliary notices are committed: a build never fetches mutable license text.
for (const file of ['bufbuild-Apache-2.0.txt', 'wxt-MIT.txt'])
  await fs.access('public/licenses/' + file);
await fs.copyFile('LICENSE', 'public/LICENSE');
await fs.copyFile('PRIVACY.md', 'public/PRIVACY.md');
await fs.copyFile(
  mediaSource.archive,
  `public/licenses/${mediaSource.filename}`,
);
