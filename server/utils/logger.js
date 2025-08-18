import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..', '..');

export class Logger {
  constructor() {
    this.logDir = join(ROOT_DIR, 'runs');
    this.logFile = join(this.logDir, `exploration-${Date.now()}.log`);
    this.initialize();
  }

  async initialize() {
    await mkdir(this.logDir, { recursive: true });
  }

  async log(event, data) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      event,
      data
    };
    
    try {
      await appendFile(
        this.logFile,
        JSON.stringify(logEntry) + '\n'
      );
    } catch (error) {
      console.error('Failed to write log:', error);
    }
  }
}