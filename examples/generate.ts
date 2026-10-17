import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { diffScreenshots } from '../src/diff.js';

const folder = new URL('./', import.meta.url);
await mkdir(folder, { recursive: true });

function screenshot(after: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
  <rect width="960" height="640" fill="#f3f5f9"/>
  <rect width="200" height="640" fill="#172239"/>
  <g font-family="Arial, sans-serif">
    <text x="28" y="53" font-size="22" font-weight="700" fill="white">Workspace</text>
    <rect x="16" y="89" width="168" height="43" rx="8" fill="#2b3c59"/>
    <text x="31" y="116" font-size="14" fill="white">Overview</text>
    <text x="31" y="164" font-size="14" fill="#a8b6cb">Projects</text>
    <text x="31" y="208" font-size="14" fill="#a8b6cb">Activity</text>
    <text x="240" y="63" font-size="27" font-weight="700" fill="#172239">Project overview</text>
    <text x="240" y="94" font-size="14" fill="#64748b">A clear picture of your team's work.</text>
    <rect x="240" y="127" width="320" height="117" rx="12" fill="white"/>
    <text x="262" y="159" font-size="13" fill="#64748b">Active projects</text>
    <text x="262" y="210" font-size="36" font-weight="700" fill="#172239">${after ? '14' : '12'}</text>
    <rect x="580" y="127" width="340" height="117" rx="12" fill="white"/>
    <text x="602" y="159" font-size="13" fill="#64748b">Tasks completed</text>
    <text x="602" y="210" font-size="36" font-weight="700" fill="#172239">86</text>
    <rect x="240" y="270" width="680" height="299" rx="12" fill="white"/>
    <text x="262" y="308" font-size="18" font-weight="700" fill="#172239">Recent projects</text>
    <path d="M262 331H898M262 398H898M262 465H898" stroke="#e8edf3"/>
    <text x="262" y="372" font-size="15" fill="#172239">Storefront refresh</text>
    <text x="262" y="439" font-size="15" fill="#172239">Mobile onboarding</text>
    <text x="262" y="506" font-size="15" fill="#172239">Customer dashboard</text>
    <rect x="786" y="350" width="106" height="30" rx="15" fill="#e2f4e9"/>
    <text x="804" y="370" font-size="12" fill="#267548">On track</text>
    <rect x="786" y="417" width="106" height="30" rx="15" fill="#fff0d1"/>
    <text x="804" y="437" font-size="12" fill="#996414">In review</text>
    <rect x="786" y="484" width="106" height="30" rx="15" fill="#e2f4e9"/>
    <text x="804" y="504" font-size="12" fill="#267548">On track</text>
    <rect x="${after ? 742 : 764}" y="38" width="${after ? 178 : 156}" height="43" rx="8" fill="${after ? '#dc583d' : '#3367dd'}"/>
    <text x="${after ? 765 : 787}" y="65" font-size="14" font-weight="700" fill="white">Create project</text>
  </g></svg>`;
}

const before = fileURLToPath(new URL('before.png', folder));
const after = fileURLToPath(new URL('after.png', folder));
const output = fileURLToPath(new URL('highlighted.png', folder));
await sharp(Buffer.from(screenshot(false))).png().toFile(before);
await sharp(Buffer.from(screenshot(true))).png().toFile(after);
const result = await diffScreenshots(before, after, { output });
console.log(`Example: ${result.changedPixels} changed pixels (${result.changedPercentage.toFixed(2)}%).`);
console.log(`Before: ${before}\nAfter: ${after}\nHighlighted: ${output}`);
