import fs from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
const svg = await fs.readFile('public/brand/logo.svg', 'utf8');
await fs.mkdir('public/icons', { recursive: true });
await fs.mkdir('docs/assets', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await fs.writeFile(
    `public/icons/${size}.png`,
    new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng(),
  );
}
await fs.writeFile(
  'docs/assets/logo.png',
  new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng(),
);
const mark = svg.slice(svg.indexOf('<rect'), svg.lastIndexOf('</svg>'));
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420">
<rect width="1200" height="420" rx="24" fill="#f5f7f2"/>
<g transform="translate(72 95) scale(1.5)">${mark}</g>
<g font-family="Arial,Helvetica,sans-serif" fill="#164a3f">
<text x="314" y="163" font-size="64" font-weight="700" letter-spacing="-2">Video Dub</text>
<text x="317" y="220" font-size="25" fill="#4f665d">Another language. The same timeline.</text>
<text x="317" y="275" font-size="17" fill="#61736a">Original-voice translation · In-page playback · Open source</text>
<text x="76" y="365" font-size="12" font-weight="700" letter-spacing="2" fill="#6c8075">POWERED BY QWEN LIVETRANSLATE</text>
</g>
<path d="M1025 81v258" stroke="#dce6dc" stroke-width="2"/>
<g fill="#bddfca"><rect x="998" y="176" width="12" height="68" rx="6"/><rect x="1020" y="147" width="12" height="126" rx="6"/><rect x="1042" y="165" width="12" height="90" rx="6"/><rect x="1064" y="189" width="12" height="42" rx="6"/><rect x="1086" y="200" width="12" height="20" rx="6"/></g>
</svg>`;
await fs.writeFile('docs/assets/banner.svg', banner);
// Store tile is a separate composition, not a distorted banner.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280"><rect width="440" height="280" fill="#f5f7f2"/><g transform="translate(32 32) scale(.65)">${mark}</g><g font-family="Arial,Helvetica,sans-serif" fill="#164a3f"><text x="32" y="169" font-size="42" font-weight="700" letter-spacing="-1">Video Dub</text><text x="34" y="205" font-size="17">Watch in another language.</text><text x="34" y="232" font-size="13" fill="#61736a">Qwen LiveTranslate · Open source</text></g></svg>`;
await fs.mkdir('docs/store/assets', { recursive: true });
await fs.writeFile(
  'docs/store/assets/small-promo-440x280.png',
  new Resvg(tile).render().asPng(),
);
