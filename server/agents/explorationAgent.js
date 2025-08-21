import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { OpenAIService } from '../services/openai.js';
import { CoverageTracker } from '../services/coverage.js';
import { Pathfinder } from '../services/pathfinder.js';
import { ScreenshotService } from '../utils/screenshot.js';
import { v4 as uuidv4 } from 'uuid';

export class ExplorationAgent {
  constructor(globalExploration, logger) {
    this.globalExploration = globalExploration;  // Reference to global exploration for broadcasting
    this.logger = logger;
    this.runId = uuidv4();
    this.stepCount = 0;
    this.isStepExecuting = false;  // Internal lock for step execution
    
    this.streetViewHeadless = new StreetViewHeadless();
    this.ai = new OpenAIService();
    this.coverage = new CoverageTracker();
    this.pathfinder = new Pathfinder(this.coverage);
    this.screenshot = new ScreenshotService(this.runId);
    
    this.currentPosition = {
      lat: parseFloat(process.env.START_LAT),
      lng: parseFloat(process.env.START_LNG)
    };
    this.currentPanoId = process.env.START_PANO_ID || null;
    this.startPanoId = process.env.START_PANO_ID || null;
    this.currentHeading = 0;
    
    // Mode tracking
    this.mode = 'exploration'; // 'exploration' or 'pathfinding'
    this.pathToFrontier = null;
    this.stuckCounter = 0;
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
        lat: panoData.position.lat,
        lng: panoData.position.lng
      };
    } else {
      panoData = await this.streetViewHeadless.getPanorama(this.currentPosition);
    }
    
    this.currentPanoId = panoData.panoId;
    this.streetViewHeadless.currentPanoId = this.currentPanoId;  // Track in Puppeteer for refresh
    this.coverage.addVisited(this.currentPanoId, this.currentPosition, panoData.links || []);
    
    // Broadcast to all connected clients
    this.globalExploration.broadcast('position-update', {
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
    // Check if a step is already executing
    if (this.isStepExecuting) {
      console.warn('Step already executing, skipping concurrent execution');
      return null;
    }
    
    try {
      this.isStepExecuting = true;
      
      // Store the current step number at the start
      const currentStep = this.stepCount + 1;
      this.stepCount = currentStep;
      console.log(`\n=== Starting step ${currentStep} ===`);
    
      // Check if Puppeteer needs refresh to prevent memory buildup
      if (this.streetViewHeadless.shouldRefresh(currentStep)) {
        console.log(`📊 Memory check at step ${currentStep}: RSS=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB, Heap=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`);
        
        // Use page refresh for regular intervals, browser restart for major milestones
        if (currentStep % 1000 === 0) {
          // Full browser restart every 1000 steps
          await this.streetViewHeadless.refreshBrowser();
        } else {
          // Page refresh every 500 steps or hourly
          await this.streetViewHeadless.refreshPage();
        }
      }
    
      // Get data for the current panorama directly (no coordinate conversion)
      const panoData = await this.streetViewHeadless.getCurrentPanorama();
      const links = panoData.links || [];
      
      // Update our tracking to ensure we're in sync
      this.currentPanoId = panoData.panoId;
      this.currentPosition = {
        lat: panoData.position.lat,
        lng: panoData.position.lng
      };
      
      // Log current location details and frontier status
      console.log(`Current location - PanoID: ${this.currentPanoId}, Lat: ${this.currentPosition.lat.toFixed(6)}, Lng: ${this.currentPosition.lng.toFixed(6)}`);
      console.log(`Frontier size: ${this.coverage.getFrontierSize()}, Mode: ${this.mode}`);
      
      // Check if we're stuck in a loop
      const isStuck = this.coverage.isInLoop(this.currentPanoId) && 
                      links.every(link => this.coverage.hasVisited(link.pano));
      
      let selectedLink = null;
      let decision = null;
      let screenshots = [];  // Declare at higher scope to avoid reference error
      
      // Determine mode and select next move
      if (isStuck && this.coverage.hasFrontier()) {
        // Switch to pathfinding mode - no screenshots needed
        this.mode = 'pathfinding';
        console.log('Visited all links - switching to pathfinding mode (no screenshots)');
        
        const pathInfo = this.pathfinder.findPathToNearestFrontier(this.currentPanoId);
        if (pathInfo) {
          // Find the link that leads to the next step in path
          selectedLink = links.find(l => l.pano === pathInfo.nextStep);
          if (selectedLink) {
            decision = {
              selectedPanoId: selectedLink.pano,
              reasoning: `Pathfinding to frontier (step ${pathInfo.currentStep}/${pathInfo.totalSteps})`
            };
            console.log(`Pathfinding: Next step to ${selectedLink.pano}`);
            // No screenshots in pathfinding mode
            screenshots = [];
          }
        } else {
          // No path found, try escape heuristic
          selectedLink = this.pathfinder.findBestEscapeDirection(this.currentPanoId, links);
          if (selectedLink) {
            decision = {
              selectedPanoId: selectedLink.pano,
              reasoning: 'Escaping local area using heuristic'
            };
            // No screenshots in pathfinding mode
            screenshots = [];
          }
        }
      }
      
      // If not stuck or no pathfinding solution, use normal exploration
      if (!selectedLink) {
        const unvisitedLinks = links.filter(link => 
          !this.coverage.hasVisited(link.pano)
        );
        
        const targetLinks = unvisitedLinks.length > 0 ? unvisitedLinks : links;
        
        // Check if only one valid link exists - cost saving mechanism
        if (targetLinks.length === 1) {
          this.mode = 'pathfinding'; // Use pathfinding mode for single-link steps (no screenshots)
          selectedLink = targetLinks[0];
          
          decision = {
            selectedPanoId: selectedLink.pano,
            reasoning: 'Only one available path - proceeding automatically'
          };
          
          // No screenshots for single-link pathfinding
          screenshots = [];
          
          console.log(`✓ Single link detected - auto-navigating to ${selectedLink.pano} (no screenshots)`);
        } else {
          // Multiple links available - use AI for decision
          this.mode = 'exploration';
          
          // Use the screenshots array declared at higher scope
          screenshots = [];
          
          // Capture screenshots with the current step number
          for (const link of targetLinks) {
            const heading = parseFloat(link.heading);
            await this.streetViewHeadless.setHeading(heading);
            
            const screenshotData = await this.screenshot.capture(
              currentStep,  // Use the captured step number
              heading,
              await this.streetViewHeadless.getScreenshot()
            );
            
            console.log(`Captured screenshot: step=${currentStep}, filename=${screenshotData.filename}`);
            
            // Validate that the filename matches the current step
            if (!screenshotData.filename.startsWith(`${currentStep}-`)) {
              console.error(`Screenshot filename mismatch! Expected step ${currentStep}, got ${screenshotData.filename}`);
            }
            
            screenshots.push({
              direction: heading,
              filename: screenshotData.filename,
              thumbFilename: screenshotData.thumbFilename,
              filepath: screenshotData.filepath,  // Track for deletion
              panoId: link.pano,
              description: link.description || '',
              visited: this.coverage.hasVisited(link.pano),
              base64: screenshotData.base64,  // Full-size for AI
              position: this.currentPosition  // Add current position for Google Maps links
            });
            
            await new Promise(resolve => setTimeout(resolve, 100));  // Reduced delay for faster execution
          }
          
          const visitedPanos = unvisitedLinks.length === 0 ? 
            this.coverage.getVisitedList() : [];
          
          decision = await this.ai.decideNextMove({
            currentPosition: this.currentPosition,
            screenshots,
            links: targetLinks,  // Only pass links we have screenshots for
            visitedPanos,
            stats: this.coverage.getStats(),
            stepNumber: currentStep,
            mode: this.mode
          });
          
          // Clear base64 data and delete full-size files after AI decision
          for (const s of screenshots) {
            delete s.base64;  // Clear from memory
            
            // Delete full-size screenshot file, keep only thumbnail
            if (s.filepath) {
              try {
                const fs = await import('fs/promises');
                await fs.unlink(s.filepath);
                console.log(`Deleted full-size screenshot: ${s.filename}`);
              } catch (err) {
                console.error(`Failed to delete full-size screenshot: ${s.filename}`, err);
              }
            }
          }
          
          selectedLink = links.find(l => l.pano === decision.selectedPanoId);
        }
      }
      
      if (!selectedLink) {
        throw new Error('Invalid panorama selection');
      }
      
      // Log successful AI selection
      console.log(`✓ AI successfully selected panoId: ${selectedLink.pano} | Reasoning: ${decision.reasoning}`);
      
      await this.streetViewHeadless.navigateToPano(selectedLink.pano);
      // Get the current panorama data after navigation (ensures we have the actual displayed pano)
      const newPanoData = await this.streetViewHeadless.getCurrentPanorama();
      
      this.currentPosition = {
        lat: newPanoData.position.lat,
        lng: newPanoData.position.lng
      };
      this.currentPanoId = newPanoData.panoId;  // Use the actual pano ID from the panorama
      
      // Update coverage with new panorama's links for frontier tracking
      const newLinks = newPanoData.links || [];
      this.coverage.addVisited(this.currentPanoId, this.currentPosition, newLinks);
      
      // Process screenshots for all modes (exploration, pathfinding, single-link)
      let thumbnailUrls = [];
      if (screenshots && screenshots.length > 0) {
        const invalidScreenshots = screenshots.filter(s => !s.filename.startsWith(`${currentStep}-`));
        if (invalidScreenshots.length > 0) {
          console.error(`WARNING: Found ${invalidScreenshots.length} screenshots with wrong step number!`);
          invalidScreenshots.forEach(s => console.error(`  Invalid: ${s.filename}`));
        }
        
        thumbnailUrls = screenshots.map(s => {
          // Use thumbnail for client display
          const thumbUrl = `/runs/shots/${this.runId}/${currentStep}/${s.thumbFilename}`;
          //console.log(`  Mapping: ${s.thumbFilename} -> ${thumbUrl}`);
          return {
            direction: s.direction,
            visited: s.visited,
            thumbnail: thumbUrl,  // Send thumbnail URL to client
            position: s.position  // Include position for Google Maps links
          };
        });
      }
      
      console.log(`Step ${currentStep} (${this.mode}): Broadcasting ${thumbnailUrls.length} thumbnail${thumbnailUrls.length !== 1 ? 's' : ''}`);
      
      // Prepare minimal step data for decision history
      const stepData = {
        stepCount: currentStep,
        reasoning: decision.reasoning,
        panoId: selectedLink.pano,
        direction: parseFloat(selectedLink.heading),
        mode: this.mode,
        screenshots: thumbnailUrls
      };
      
      // Prepare broadcast data with additional info for UI updates
      const broadcastData = {
        ...stepData,
        newPosition: this.currentPosition,  // Send position delta
        stats: this.coverage.getStats()      // Send updated stats
      };
      
      // Broadcast to all connected clients
      this.globalExploration.broadcast('move-decision', broadcastData);
      
      this.logger.log('exploration-step', {
        step: currentStep,
        from: this.currentPanoId,
        to: selectedLink.pano,
        decision: decision.reasoning,
        position: this.currentPosition,
        stats: this.coverage.getStats()
      });
      
      // Return step data for caching
      return stepData;
      
    } finally {
      // Always clear the lock when done
      this.isStepExecuting = false;
      console.log(`=== Completed step ${this.stepCount} ===`);
    }
  }

  async reset() {
    // Reset position and state
    this.currentPosition = {
      lat: parseFloat(process.env.START_LAT),
      lng: parseFloat(process.env.START_LNG)
    };
    this.currentPanoId = this.startPanoId;
    this.currentHeading = 0;
    this.stepCount = 0;
    this.coverage.reset();
    
    // Generate new run ID for new exploration
    this.runId = uuidv4();
    this.screenshot = new ScreenshotService(this.runId);
    
    // Close and reinitialize headless browser
    if (this.streetViewHeadless) {
      await this.streetViewHeadless.close();
      this.streetViewHeadless = new StreetViewHeadless();
    }
    
    await this.initialize();
  }
  
  async close() {
    if (this.streetViewHeadless) {
      await this.streetViewHeadless.close();
    }
  }
}