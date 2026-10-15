import fs from 'node:fs/promises';
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
// Buf's package contains generated protobuf runtime code under Apache-2.0.
for (const [name, url] of Object.entries({
  'bufbuild-Apache-2.0.txt':
    'https://raw.githubusercontent.com/bufbuild/protobuf-es/v2.16.0/LICENSE',
  'wxt-MIT.txt': 'https://raw.githubusercontent.com/wxt-dev/wxt/main/LICENSE',
})) {
  try {
    await fs.access('public/licenses/' + name);
    continue;
  } catch {}
  const response = await fetch(url);
  if (!response.ok)
    throw new Error('Unable to obtain dependency license: ' + name);
  await fs.writeFile('public/licenses/' + name, await response.text());
}
