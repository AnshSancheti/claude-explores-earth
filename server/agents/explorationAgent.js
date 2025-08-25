import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { OpenAIService } from '../services/openai.js';
import { CoverageTracker } from '../services/coverage.js';
import { Pathfinder } from '../services/pathfinder.js';
import { ScreenshotService } from '../utils/screenshot.js';
import { projectPosition } from '../utils/geoUtils.js';
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
    
    // Movement history for AI context (keep last 20 moves)
    this.recentMovements = [];
    
    // Track last navigation heading for dead-end recovery (null until first navigation)
    this.lastNavigationHeading = null;
    
    // Dead-end recovery configuration
    this.maxDeadEndDistance = parseInt(process.env.MAX_DEAD_END_DISTANCE) || 200;
    this.deadEndStepSize = 10; // meters per step
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
      let panoData = await this.streetViewHeadless.getCurrentPanorama();
      let links = panoData.links || [];
      
      // Update our tracking to ensure we're in sync
      this.currentPanoId = panoData.panoId;
      this.currentPosition = {
        lat: panoData.position.lat,
        lng: panoData.position.lng
      };
      
      // Handle dead-end panoramas (no outgoing links)
      let deadEndRecovery = false;
      let deadEndDistance = 0;
      
      if (links.length === 0 && this.lastNavigationHeading !== null) {
        console.log(`⚠️ Dead-end panorama detected at ${this.currentPanoId}, attempting to continue in heading ${this.lastNavigationHeading}°...`);
        
        // Store original position for broadcast
        const originalPanoId = this.currentPanoId;
        
        // Try to find a valid panorama by continuing in the same direction
        const recoveredPano = await this.recoverFromDeadEnd();
        
        if (recoveredPano) {
          // Successfully found a panorama with links
          panoData = recoveredPano;
          links = panoData.links || [];
          
          // Update position to the recovered panorama
          this.currentPanoId = panoData.panoId;
          this.currentPosition = {
            lat: panoData.position.lat,
            lng: panoData.position.lng
          };
          
          // Mark that we recovered from a dead-end
          deadEndRecovery = true;
          // Calculate approximate distance traveled during recovery
          deadEndDistance = this.recentMovements.length > 0 ? 
            parseInt(this.recentMovements[this.recentMovements.length - 1].reasoning.match(/(\d+)m/)?.[1] || 0) : 0;
          
          console.log(`✓ Recovered from dead-end, now at ${this.currentPanoId} with ${links.length} available links`);
        } else {
          console.error('❌ Could not recover from dead-end after maximum distance');
          // Continue with empty links - will throw error below
        }
      }
      
      // Log current location details and frontier status
      console.log(`Current location - PanoID: ${this.currentPanoId}, Lat: ${this.currentPosition.lat.toFixed(6)}, Lng: ${this.currentPosition.lng.toFixed(6)}`);
      console.log(`Frontier size: ${this.coverage.getFrontierSize()}, Mode: ${this.mode}`);
      
      // Check if we're stuck in a loop
      const isStuck = this.coverage.isInLoop(this.currentPanoId) && 
                      links.every(link => this.coverage.hasVisited(link.pano));
      
      let selectedLink = null;
      let decision = null;
      let screenshots = [];  // Declare at higher scope to avoid reference error
      
      // If we just recovered from a dead-end, broadcast that special state
      if (deadEndRecovery) {
        // Create a special broadcast for dead-end recovery
        const recoveryData = {
          stepCount: currentStep,
          reasoning: `Navigating through dead-end (${deadEndDistance}m of sparse coverage)`,
          panoId: this.currentPanoId,
          direction: this.lastNavigationHeading,
          mode: 'dead-end-recovery',
          screenshots: [],  // No screenshots during recovery
          newPosition: this.currentPosition,
          stats: this.coverage.getStats()
        };
        
        // Broadcast the recovery
        this.globalExploration.broadcast('move-decision', recoveryData);
        
        // Now continue normal exploration from the recovered position
      }
      
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
        // Check if we have no links at all (dead-end with no recovery possible)
        if (links.length === 0) {
          console.error('❌ No available links and cannot recover. This may be a dead-end panorama loaded from a save.');
          throw new Error('No available navigation options from current panorama');
        }
        
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
            mode: this.mode,
            recentMovements: this.recentMovements  // Pass movement history
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
      
      // Track the movement BEFORE navigating
      const previousPanoId = this.currentPanoId;
      const previousPosition = { ...this.currentPosition };
      
      // Store the heading for potential dead-end recovery
      this.lastNavigationHeading = parseFloat(selectedLink.heading);
      
      await this.streetViewHeadless.navigateToPano(selectedLink.pano);
      // Get the current panorama data after navigation (ensures we have the actual displayed pano)
      const newPanoData = await this.streetViewHeadless.getCurrentPanorama();
      
      this.currentPosition = {
        lat: newPanoData.position.lat,
        lng: newPanoData.position.lng
      };
      this.currentPanoId = newPanoData.panoId;  // Use the actual pano ID from the panorama
      
      // Add this movement to history
      this.recentMovements.push({
        from: previousPanoId,
        to: this.currentPanoId,
        fromPosition: previousPosition,
        toPosition: { ...this.currentPosition },
        heading: selectedLink.heading,
        step: currentStep,
        reasoning: decision.reasoning
      });
      
      // Keep only last 20 movements
      if (this.recentMovements.length > 20) {
        this.recentMovements.shift();
      }
      
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

  /**
   * Attempt to recover from a dead-end panorama by continuing in the same direction
   * @returns {Object|null} Recovered panorama data with links, or null if recovery failed
   */
  async recoverFromDeadEnd() {
    const maxAttempts = Math.floor(this.maxDeadEndDistance / this.deadEndStepSize);
    let currentPos = { ...this.currentPosition };
    let attemptedPositions = [];
    
    // Track the original dead-end for movement history
    const deadEndPanoId = this.currentPanoId;
    const deadEndPosition = { ...this.currentPosition };
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Project forward by stepSize in the last navigation heading
      currentPos = projectPosition(currentPos, this.lastNavigationHeading, this.deadEndStepSize);
      attemptedPositions.push({ ...currentPos });
      
      console.log(`  Attempt ${attempt + 1}: Checking position ${currentPos.lat.toFixed(6)}, ${currentPos.lng.toFixed(6)} (${(attempt + 1) * this.deadEndStepSize}m forward)`);
      
      try {
        // Try to get panorama at the projected position
        const testPano = await this.streetViewHeadless.getPanorama(currentPos);
        
        if (testPano && testPano.links && testPano.links.length > 0) {
          console.log(`  ✓ Found valid panorama ${testPano.panoId} after ${(attempt + 1) * this.deadEndStepSize}m with ${testPano.links.length} links`);
          
          // Navigate to the recovered panorama
          await this.streetViewHeadless.navigateToPano(testPano.panoId);
          
          // Add the dead-end recovery movement to history
          this.recentMovements.push({
            from: deadEndPanoId,
            to: testPano.panoId,
            fromPosition: deadEndPosition,
            toPosition: {
              lat: testPano.position.lat,
              lng: testPano.position.lng
            },
            heading: this.lastNavigationHeading,
            step: this.stepCount,
            reasoning: `Navigating through dead-end (recovered after ${(attempt + 1) * this.deadEndStepSize}m)`
          });
          
          // Keep only last 20 movements
          if (this.recentMovements.length > 20) {
            this.recentMovements.shift();
          }
          
          // Add the dead-end panorama to visited (even though it has no links)
          this.coverage.addVisited(deadEndPanoId, deadEndPosition, []);
          
          // Add the recovered panorama to visited
          this.coverage.addVisited(testPano.panoId, testPano.position, testPano.links);
          
          return testPano;
        }
      } catch (error) {
        // No panorama at this position, continue searching
        console.log(`  No panorama found at this position`);
      }
    }
    
    console.log(`  ❌ Could not find valid panorama after ${this.maxDeadEndDistance}m`);
    return null;
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
    this.lastNavigationHeading = null;  // Reset to null, not 0
    this.recentMovements = [];
    
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