import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..', '..');

export class ScreenshotService {
  constructor(runId) {
    this.runId = runId;
    this.baseDir = join(ROOT_DIR, 'runs', 'shots', runId);
    // Thumbnail settings
    this.thumbnailWidth = 320;  // Width for thumbnails (16:9 aspect ratio)
    this.thumbnailHeight = 180; // Height for thumbnails
    this.thumbnailQuality = 70; // JPEG quality for thumbnails
  }

  async initialize() {
    await mkdir(this.baseDir, { recursive: true });
  }

  async capture(stepNumber, heading, screenshotBuffer) {
    const stepDir = join(this.baseDir, stepNumber.toString());
    await mkdir(stepDir, { recursive: true });
    
    const baseFilename = `${stepNumber}-dir${Math.round(heading)}`;
    const fullFilename = `${baseFilename}.jpg`;
    const thumbFilename = `${baseFilename}-thumb.jpg`;
    
    const fullPath = join(stepDir, fullFilename);
    const thumbPath = join(stepDir, thumbFilename);
    
    // Save full-size screenshot
    await writeFile(fullPath, screenshotBuffer);
    
    // Create and save thumbnail
    const thumbnailBuffer = await sharp(screenshotBuffer)
      .resize(this.thumbnailWidth, this.thumbnailHeight, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: this.thumbnailQuality })
      .toBuffer();
    
    await writeFile(thumbPath, thumbnailBuffer);
    
    // Return both filenames and base64 of full image for the AI
    return {
      filename: fullFilename,
      thumbFilename: thumbFilename,
      base64: screenshotBuffer.toString('base64'), // Full size for AI
      filepath: fullPath,
      thumbPath: thumbPath
    };
  }
}