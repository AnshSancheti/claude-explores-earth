import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..', '..');

export class ScreenshotService {
  constructor(runId) {
    this.runId = runId;
    this.baseDir = join(ROOT_DIR, 'runs', 'shots', runId);
  }

  async initialize() {
    await mkdir(this.baseDir, { recursive: true });
  }

  async capture(stepNumber, heading, screenshotBuffer) {
    const stepDir = join(this.baseDir, stepNumber.toString());
    await mkdir(stepDir, { recursive: true });
    
    const filename = `${stepNumber}-dir${Math.round(heading)}.jpg`;
    const filepath = join(stepDir, filename);
    
    await writeFile(filepath, screenshotBuffer);
    
    // Return both the filename and base64 for the AI
    return {
      filename: filename,
      base64: screenshotBuffer.toString('base64'),
      filepath: filepath
    };
  }
}