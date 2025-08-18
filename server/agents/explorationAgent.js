import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { OpenAIService } from '../services/openai.js';
import { CoverageTracker } from '../services/coverage.js';
import { ScreenshotService } from '../utils/screenshot.js';
import { v4 as uuidv4 } from 'uuid';

export class ExplorationAgent {
  constructor(socket, logger) {
    this.socket = socket;
    this.logger = logger;
    this.runId = uuidv4();
    this.stepCount = 0;
    
    this.streetViewHeadless = new StreetViewHeadless();
    this.ai = new OpenAIService();
    this.coverage = new CoverageTracker();
    this.screenshot = new ScreenshotService(this.runId);
    
    this.currentPosition = {
      lat: parseFloat(process.env.START_LAT),
      lng: parseFloat(process.env.START_LNG)
    };
    this.currentPanoId = process.env.START_PANO_ID || null;
    this.startPanoId = process.env.START_PANO_ID || null;
    this.currentHeading = 0;
  }

  async initialize() {
    await this.streetViewHeadless.initialize();
    await this.screenshot.initialize();
    
    // If we have a starting pano ID, use it; otherwise use lat/lng
    let panoData;
    if (this.startPanoId) {
      panoData = await this.streetViewHeadless.getPanorama(this.startPanoId);
      // Update position from the panorama data
      this.currentPosition = {
        lat: panoData.location.lat,
        lng: panoData.location.lng
      };
    } else {
      panoData = await this.streetViewHeadless.getPanorama(this.currentPosition);
    }
    
    this.currentPanoId = panoData.pano_id;
    this.coverage.addVisited(this.currentPanoId, this.currentPosition);
    
    this.socket.emit('position-update', {
      position: this.currentPosition,
      panoId: this.currentPanoId,
      stats: this.coverage.getStats()
    });
    
    this.logger.log('exploration-started', {
      runId: this.runId,
      startPosition: this.currentPosition,
      startPanoId: this.currentPanoId
    });
  }

  async exploreStep() {
    this.stepCount++;
    console.log(`\n=== Starting step ${this.stepCount} ===`);
    
    // Get data for the current panorama directly (no coordinate conversion)
    const panoData = await this.streetViewHeadless.getCurrentPanorama();
    const links = panoData.links || [];
    
    // Update our tracking to ensure we're in sync
    this.currentPanoId = panoData.pano_id;
    this.currentPosition = {
      lat: panoData.location.lat,
      lng: panoData.location.lng
    };
    
    const unvisitedLinks = links.filter(link => 
      !this.coverage.hasVisited(link.pano)
    );
    
    const targetLinks = unvisitedLinks.length > 0 ? unvisitedLinks : links;
    
    const screenshots = [];
    for (const link of targetLinks) {
      const heading = parseFloat(link.heading);
      await this.streetViewHeadless.setHeading(heading);
      
      const screenshotData = await this.screenshot.capture(
        this.stepCount,
        heading,
        await this.streetViewHeadless.getScreenshot()
      );
      
      console.log(`Captured screenshot: step=${this.stepCount}, filename=${screenshotData.filename}`);
      
      screenshots.push({
        direction: heading,
        filename: screenshotData.filename,
        panoId: link.pano,
        description: link.description || '',
        visited: this.coverage.hasVisited(link.pano),
        base64: screenshotData.base64
      });
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const visitedPanos = unvisitedLinks.length === 0 ? 
      this.coverage.getVisitedList() : [];
    
    const decision = await this.ai.decideNextMove({
      currentPosition: this.currentPosition,
      screenshots,
      links: targetLinks,  // Only pass links we have screenshots for
      visitedPanos,
      stats: this.coverage.getStats()
    });
    
    const selectedLink = links.find(l => l.pano === decision.selectedPanoId);
    if (!selectedLink) {
      throw new Error('Invalid panorama selection');
    }
    
    // Log successful AI selection
    console.log(`✓ AI successfully selected panoId: ${selectedLink.pano} | Reasoning: ${decision.reasoning}`);
    
    await this.streetViewHeadless.navigateToPano(selectedLink.pano);
    // Get the current panorama data after navigation (ensures we have the actual displayed pano)
    const newPanoData = await this.streetViewHeadless.getCurrentPanorama();
    
    this.currentPosition = {
      lat: newPanoData.location.lat,
      lng: newPanoData.location.lng
    };
    this.currentPanoId = newPanoData.pano_id;  // Use the actual pano ID from the panorama
    
    this.coverage.addVisited(this.currentPanoId, this.currentPosition);
    
    const thumbnailUrls = screenshots.map(s => {
      const url = `/runs/shots/${this.runId}/${this.stepCount}/${s.filename}`;
      console.log(`  Mapping: ${s.filename} -> ${url}`);
      return {
        direction: s.direction,
        visited: s.visited,
        thumbnail: url
      };
    });
    
    console.log(`Sending ${thumbnailUrls.length} thumbnails for step ${this.stepCount}`);
    
    this.socket.emit('move-decision', {
      stepCount: this.stepCount,
      decision: {
        reasoning: decision.reasoning,
        selectedPanoId: decision.selectedPanoId,
        direction: parseFloat(selectedLink.heading)
      },
      panoId: selectedLink.pano,
      screenshots: thumbnailUrls,
      newPosition: this.currentPosition,
      stats: this.coverage.getStats()
    });
    
    this.logger.log('exploration-step', {
      step: this.stepCount,
      from: this.currentPanoId,
      to: selectedLink.pano,
      decision: decision.reasoning,
      position: this.currentPosition,
      stats: this.coverage.getStats()
    });
  }

  async reset() {
    this.currentPosition = {
      lat: parseFloat(process.env.START_LAT),
      lng: parseFloat(process.env.START_LNG)
    };
    this.currentPanoId = this.startPanoId;
    this.currentHeading = 0;
    this.stepCount = 0;
    this.coverage.reset();
    
    await this.initialize();
  }
}