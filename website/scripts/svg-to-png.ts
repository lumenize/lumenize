import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Resvg } from '@resvg/resvg-js';

// Polyfill __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory containing SVGs
const svgDir = path.resolve(__dirname, '../static/img');
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
      
      try {
        const svgContent = await fs.readFile(svgPath, 'utf8');
        const resvg = new Resvg(svgContent, { fitTo: { mode: 'width', value: 512 } });
        const pngData = resvg.render().asPng();
        await fs.writeFile(pngPath, pngData);
        console.log(`Converted ${file} -> ${path.basename(pngPath)}`);
        
        // Special handling for logo.svg to also create favicon.ico
        if (file === 'logo.svg') {
          const icoPath = path.join(pngDir, 'favicon.ico');
          try {
            await convertPngToIco(pngPath, icoPath);
            console.log(`Converted ${path.basename(pngPath)} -> favicon.ico`);
          } catch (error) {
            console.error(`Failed to convert to ICO: ${error}`);
          }
        }
      } catch (error) {
        console.error(`Failed to process ${file}: ${error}`);
      }
    }
  }
}

async function convertPngToIco(pngPath: string, icoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('npx', ['png-to-ico', pngPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    const chunks: Buffer[] = [];
    process.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    process.on('close', async (code) => {
      if (code === 0) {
        try {
          const icoData = Buffer.concat(chunks);
          await fs.writeFile(icoPath, icoData);
          resolve();
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error(`png-to-ico exited with code ${code}`));
      }
    });
    
    process.on('error', (error) => {
      reject(error);
    });
  });
}

convertAllSVGs().catch(err => {
  console.error('Error converting SVGs:', err);
  process.exit(1);
});
