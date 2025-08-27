import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resvg } from '@resvg/resvg-js';

// Polyfill __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory containing SVGs
const svgDir = path.resolve(__dirname, '../assets');
// Output directory for PNGs (same as SVGs)
const pngDir = svgDir;

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {}
}

async function convertAllSVGs() {
  await ensureDir(pngDir);
  const files = await fs.readdir(svgDir);
  for (const file of files) {
    if (file.endsWith('.svg')) {
      const svgPath = path.join(svgDir, file);
      const pngPath = path.join(pngDir, file.replace(/\.svg$/, '.png'));
      const svgContent = await fs.readFile(svgPath, 'utf8');
      const resvg = new Resvg(svgContent, { fitTo: { mode: 'width', value: 512 } });
      const pngData = resvg.render().asPng();
      await fs.writeFile(pngPath, pngData);
      console.log(`Converted ${file} -> ${path.basename(pngPath)}`);
    }
  }
}

convertAllSVGs().catch(err => {
  console.error('Error converting SVGs:', err);
  process.exit(1);
});
