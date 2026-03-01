import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { OpenAIService } from '../services/openai.js';
import { CoverageTracker } from '../services/coverage.js';
import { Pathfinder } from '../services/pathfinder.js';
import { ScreenshotService } from '../utils/screenshot.js';
import { maybeSignPath } from '../utils/urlSigner.js';
import { projectPosition } from '../utils/geoUtils.js';
import { v4 as uuidv4 } from 'uuid';

export function selectClosestFrontierByDiscovery(frontiers, graph, currentPosition, calculateDistance) {
  let closestFrontier = null;
  let closestAnchorPosition = null;
  let closestDistance = Infinity;

  for (const frontier of frontiers) {
    const discoveredFrom = frontier?.discoveredFrom;
    if (!discoveredFrom) continue;

    const node = graph.get(discoveredFrom);
    if (!node || typeof node.lat !== 'number' || typeof node.lng !== 'number') {
      continue;
    }

    const anchorPosition = { lat: node.lat, lng: node.lng };
    const distance = calculateDistance(currentPosition, anchorPosition);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestFrontier = frontier;
      closestAnchorPosition = anchorPosition;
    }
  }

  if (!closestFrontier) return null;
  return {
    frontier: closestFrontier,
    anchorPosition: closestAnchorPosition,
    distanceMeters: closestDistance
  };
}

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

    // Spatial stagnation guard: force escape if we keep moving without entering new map cells.
    this.stepsSinceNewCell = 0;
    const parseOr = (value, fallback) => {
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    this.staleCellThresholdSteps = parseOr(process.env.STALE_CELL_THRESHOLD_STEPS ?? '120', 120);
    this.loopWindowNodes = parseOr(process.env.SINGLE_LINK_LOOP_WINDOW_NODES ?? '6', 6);
    this.repeatingLoopMinPeriod = parseOr(process.env.REPEATING_LOOP_MIN_PERIOD ?? '2', 2);
    this.repeatingLoopMaxPeriod = parseOr(process.env.REPEATING_LOOP_MAX_PERIOD ?? '6', 6);
    this.repeatingLoopMinRepeats = parseOr(process.env.REPEATING_LOOP_MIN_REPEATS ?? '3', 3);

    // Single-link probe removed per request
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
    const startVisit = this.coverage.addVisited(this.currentPanoId, this.currentPosition, panoData.links || []);
    this.stepsSinceNewCell = startVisit?.isNewCell ? 0 : 1;
    
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
      const repeatingLoopOptions = {
        minPeriod: this.repeatingLoopMinPeriod,
        maxPeriod: this.repeatingLoopMaxPeriod,
        minRepeats: this.repeatingLoopMinRepeats
      };
      const wouldExtendLoopTail = (panoId) => (
        this.coverage.isAlternatingLoop(panoId, this.loopWindowNodes) ||
        this.coverage.wouldExtendRepeatingCycle(panoId, repeatingLoopOptions)
      );

      // If we're spatially stagnant for too long, force a frontier jump.
      if (this.stepsSinceNewCell >= this.staleCellThresholdSteps && this.coverage.hasFrontier()) {
        console.warn(`Stagnation detected: ${this.stepsSinceNewCell} steps without entering a new spatial cell. Attempting frontier teleport.`);
        const teleportStep = await this.teleportToFrontier(currentStep);
        if (teleportStep) {
          this.stepsSinceNewCell = 0;
          return teleportStep;
        }
      }
      
      // Determine if all outgoing links from current pano are already visited
      const allLinksVisited = (links.length > 0) && links.every(link => this.coverage.hasVisited(link.pano));
      
      let selectedLink = null;
      let decision = null;
      let remainingPathSteps = null; // For UI hint when pathfinding
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
        // Clear any previously planned path
        this.pathToFrontier = null;
      }
      
      // Determine mode and select next move
      // If we have a planned route to a frontier, follow it first
      if (this.pathToFrontier && Array.isArray(this.pathToFrontier) && this.pathToFrontier.length > 0) {
        const nextPlanned = this.pathToFrontier[0];
        const plannedLink = links.find(l => l.pano === nextPlanned);
        if (plannedLink) {
          this.mode = 'pathfinding';
          selectedLink = plannedLink;
          remainingPathSteps = this.pathToFrontier.length;
          decision = {
            selectedPanoId: selectedLink.pano,
            reasoning: `Pathfinding to frontier (remaining ${remainingPathSteps} step${remainingPathSteps === 1 ? '' : 's'})`
          };
          screenshots = [];
        } else {
          // Planned next hop is not available from here; invalidate and recompute below
          console.log('Path plan invalidated: next hop not in current links. Recomputing.');
          this.pathToFrontier = null;
        }
      }

      // Enter pathfinding mode whenever all links are visited and any frontier exists
      if (!selectedLink && allLinksVisited && this.coverage.hasFrontier()) {
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
              // Recalculate path each step; report remaining steps for clarity
              reasoning: `Pathfinding to frontier (remaining ${pathInfo.pathLength} step${pathInfo.pathLength === 1 ? '' : 's'})`
            };
            remainingPathSteps = pathInfo.pathLength;
            console.log(`Pathfinding: Next step to ${selectedLink.pano} (route=${pathInfo.pathLength}, expanded=${pathInfo.expanded})`);
            // No screenshots in pathfinding mode
            screenshots = [];
            // Persist full route; first hop will be consumed after navigation
            this.pathToFrontier = Array.isArray(pathInfo.fullPath) ? [...pathInfo.fullPath] : null;
          } else {
            console.log(`Graph route suggested unavailable hop ${pathInfo.nextStep}; trying cluster + teleport fallbacks.`);
          }
        }

        if (!selectedLink) {
          // Try cluster-aware routing before teleporting
          const clustered = this.pathfinder.findClusteredPathToFrontier(this.currentPanoId);
          if (clustered) {
            console.log(`Cluster route: ${clustered.clusterPathLength} clusters, expanded=${clustered.expanded}`);
            const isBoundaryHere = clustered.nextCluster === clustered.startCluster;
            let hop = null;
            if (isBoundaryHere) {
              // Prefer any unvisited neighbor from current pano if available
              const unvisitedFromCurrent = links.find(l => !this.coverage.hasVisited(l.pano));
              if (unvisitedFromCurrent) {
                hop = unvisitedFromCurrent;
              } else {
                // Reposition within cluster to a member that has unvisited neighbor
                const target = clustered.fromCandidates.find(id => id !== this.currentPanoId) || clustered.fromCandidates[0];
                if (target && target !== this.currentPanoId) {
                  return await this.#repositionWithinCluster(currentStep, target, 'Reposition within cluster to reach boundary');
                }
              }
            } else {
              // Look for a link to next cluster from current pano
              const linkToNextCluster = links.find(l => clustered.toCandidates.includes(l.pano));
              if (linkToNextCluster) {
                hop = linkToNextCluster;
              } else {
                // Reposition to a member in current cluster that has an edge to next cluster
                const target = clustered.fromCandidates.find(id => id !== this.currentPanoId) || clustered.fromCandidates[0];
                if (target && target !== this.currentPanoId) {
                  return await this.#repositionWithinCluster(currentStep, target, 'Reposition within cluster to exit toward frontier');
                }
              }
            }

            if (hop) {
              selectedLink = hop;
              decision = {
                selectedPanoId: selectedLink.pano,
                reasoning: isBoundaryHere ? 'Boundary in cluster: taking unvisited exit' : 'Cluster pathfinding: exiting cluster toward frontier'
              };
              screenshots = [];
            }
          }
        }

        if (!selectedLink) {
          // Frontier exists but is unreachable via visited graph; fall back to teleport
          const teleportStep = await this.teleportToFrontier(currentStep);
          if (teleportStep) {
            return teleportStep;
          }
        }
        
        if (!selectedLink) {
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
        
        // If unvisited links exist, prefer exploration and clear any stale path plan
        if (unvisitedLinks.length > 0 && this.pathToFrontier) {
          this.pathToFrontier = null;
        }

        const targetLinks = unvisitedLinks.length > 0 ? unvisitedLinks : links;
        const lastMove = this.recentMovements[this.recentMovements.length - 1];
        const immediateBacktrackPano = (lastMove && lastMove.to === this.currentPanoId) ? lastMove.from : null;
        const candidateLinks = (() => {
          if (!immediateBacktrackPano || targetLinks.length <= 1) return targetLinks;
          const nonBacktrack = targetLinks.filter(link => link.pano !== immediateBacktrackPano);
          return nonBacktrack.length > 0 ? nonBacktrack : targetLinks;
        })();
        let cycleSafeLinks = candidateLinks;

        if (unvisitedLinks.length === 0 && candidateLinks.length > 1) {
          const nonLoopRisk = candidateLinks.filter(link => !wouldExtendLoopTail(link.pano));
          if (nonLoopRisk.length > 0 && nonLoopRisk.length < candidateLinks.length) {
            console.log(`Loop-risk filter dropped ${candidateLinks.length - nonLoopRisk.length} candidate link(s) that continue a repeating cycle tail.`);
            cycleSafeLinks = nonLoopRisk;
          } else if (nonLoopRisk.length === 0 && this.coverage.hasFrontier()) {
            console.warn('All available links would continue a recent loop tail; forcing frontier teleport.');
            const teleportStep = await this.teleportToFrontier(currentStep);
            if (teleportStep) {
              return teleportStep;
            }
          }
        }
        
        // Check if only one valid link exists - verify via nearby probes before auto-moving
        if (cycleSafeLinks.length === 1) {
          const candidateLink = cycleSafeLinks[0];
          const wouldContinueLoop = (unvisitedLinks.length === 0) && wouldExtendLoopTail(candidateLink.pano);

          if (wouldContinueLoop && this.coverage.hasFrontier()) {
            console.warn(`Single-link oscillation detected toward ${candidateLink.pano}; forcing frontier recovery.`);
            const teleportStep = await this.teleportToFrontier(currentStep);
            if (teleportStep) {
              return teleportStep;
            }
          }

          this.mode = 'pathfinding'; // Use pathfinding mode for single-link steps (no screenshots)
          selectedLink = candidateLink;
          
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
          for (const link of cycleSafeLinks) {
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
            links: cycleSafeLinks,  // Only pass links we have screenshots for
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
          
          selectedLink = cycleSafeLinks.find(l => l.pano === decision.selectedPanoId) ||
            links.find(l => l.pano === decision.selectedPanoId) ||
            cycleSafeLinks[0];
          if (selectedLink && decision.selectedPanoId !== selectedLink.pano) {
            decision = {
              ...decision,
              selectedPanoId: selectedLink.pano,
              reasoning: `${decision.reasoning} (fallback to available candidate)`
            };
          }
        }
      }
      
      if (!selectedLink) {
        throw new Error('Invalid panorama selection');
      }

      if (this.coverage.hasVisited(selectedLink.pano) && this.coverage.hasFrontier() && wouldExtendLoopTail(selectedLink.pano)) {
        console.warn(`Selected move to ${selectedLink.pano} would extend a detected loop tail; forcing frontier teleport.`);
        const teleportStep = await this.teleportToFrontier(currentStep);
        if (teleportStep) {
          return teleportStep;
        }
      }
      
      // Log successful AI selection
      console.log(`✓ AI successfully selected panoId: ${selectedLink.pano} | Reasoning: ${decision.reasoning}`);
      
      // Track the movement BEFORE navigating
      const previousPanoId = this.currentPanoId;
      const previousPosition = { ...this.currentPosition };
      
      // Store the heading for potential dead-end recovery
      this.lastNavigationHeading = parseFloat(selectedLink.heading);
      
      // If following a planned route, consume the hop now
      if (this.pathToFrontier && this.pathToFrontier.length > 0 && this.pathToFrontier[0] === selectedLink.pano) {
        this.pathToFrontier.shift();
      }

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
      const visitInfo = this.coverage.addVisited(this.currentPanoId, this.currentPosition, newLinks);
      this.stepsSinceNewCell = visitInfo?.isNewCell ? 0 : this.stepsSinceNewCell + 1;
      
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
          const rawThumb = `/runs/shots/${this.runId}/${currentStep}/${s.thumbFilename}`;
          const thumbUrl = maybeSignPath(rawThumb, 3600);
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
        panoId: this.currentPanoId,
        direction: parseFloat(selectedLink.heading),
        mode: this.mode,
        screenshots: thumbnailUrls,
        remainingPathSteps: remainingPathSteps
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
        from: previousPanoId,
        to: this.currentPanoId,
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

  // Perform a single-step, no-screenshot intra-cluster reposition
  async #repositionWithinCluster(currentStep, targetPanoId, reason) {
    const previousPanoId = this.currentPanoId;
    const previousPosition = { ...this.currentPosition };
    try {
      await this.streetViewHeadless.navigateToPano(targetPanoId);
      const newPanoData = await this.streetViewHeadless.getCurrentPanorama();
      this.currentPanoId = newPanoData.panoId;
      this.currentPosition = { lat: newPanoData.position.lat, lng: newPanoData.position.lng };
      this.lastNavigationHeading = null; // reset directional context
      const newLinks = newPanoData.links || [];
      const visitInfo = this.coverage.addVisited(this.currentPanoId, this.currentPosition, newLinks);
      this.stepsSinceNewCell = visitInfo?.isNewCell ? 0 : this.stepsSinceNewCell + 1;

      this.recentMovements.push({
        from: previousPanoId,
        to: this.currentPanoId,
        fromPosition: previousPosition,
        toPosition: { ...this.currentPosition },
        heading: null,
        step: currentStep,
        reasoning: reason
      });
      if (this.recentMovements.length > 20) this.recentMovements.shift();

      const stepData = {
        stepCount: currentStep,
        reasoning: reason,
        panoId: this.currentPanoId,
        direction: 0,
        mode: 'pathfinding',
        screenshots: [],
        remainingPathSteps: null
      };
      const broadcastData = { ...stepData, newPosition: this.currentPosition, stats: this.coverage.getStats() };
      this.globalExploration.broadcast('move-decision', broadcastData);

      this.logger.log('exploration-step', {
        step: currentStep,
        from: previousPanoId,
        to: this.currentPanoId,
        decision: reason,
        position: this.currentPosition,
        stats: this.coverage.getStats()
      });
      return stepData;
    } catch (e) {
      console.error('Failed intra-cluster reposition:', e.message);
      return null;
    }
  }

  // Probe small radius around current position for alternate panos with more exits
  // probeAlternateExits removed per request

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
          const visitInfo = this.coverage.addVisited(testPano.panoId, testPano.position, testPano.links);
          this.stepsSinceNewCell = visitInfo?.isNewCell ? 0 : this.stepsSinceNewCell + 1;
          
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

  async teleportToFrontier(currentStep) {
    // Teleport invalidates any existing route plan
    this.pathToFrontier = null;
    const frontiers = this.coverage.getFrontiers();
    if (!frontiers || frontiers.length === 0) {
      console.warn('Teleport requested but no frontier candidates available.');
      return null;
    }

    let closestFrontier = null;
    let closestPosition = null;
    let closestDistance = Infinity;

    const discoveredClosest = selectClosestFrontierByDiscovery(
      frontiers,
      this.coverage.graph,
      this.currentPosition,
      this.coverage.calculateDistance.bind(this.coverage)
    );
    if (discoveredClosest) {
      closestFrontier = discoveredClosest.frontier;
      closestPosition = discoveredClosest.anchorPosition;
      closestDistance = discoveredClosest.distanceMeters;
    }

    let closestPanoData = null;
    if (!closestFrontier) {
      console.warn('No frontier coordinates cached in graph; falling back to last frontier.');
      const fallbackFrontier = frontiers[frontiers.length - 1];
      if (!fallbackFrontier) {
        return null;
      }
      try {
        console.log(`Fetching Street View metadata for fallback frontier ${fallbackFrontier.panoId}`);
        closestPanoData = await this.streetViewHeadless.getPanorama(fallbackFrontier.panoId);
        if (closestPanoData && closestPanoData.position) {
          closestFrontier = fallbackFrontier;
          closestPosition = {
            lat: closestPanoData.position.lat,
            lng: closestPanoData.position.lng
          };
          closestDistance = this.coverage.calculateDistance(this.currentPosition, closestPosition);
        }
      } catch (error) {
        console.error(`Failed to evaluate fallback frontier ${fallbackFrontier.panoId}:`, error.message);
        return null;
      }
    }

    if (!closestFrontier || !closestPosition) {
      console.warn('Teleport requested but no frontier metadata available after fallback.');
      return null;
    }

    console.log(`No path to frontier found. Teleporting to closest frontier ${closestFrontier.panoId} (${Math.round(closestDistance)}m away).`);

    const previousPanoId = this.currentPanoId;
    const previousPosition = { ...this.currentPosition };

    try {
      await this.streetViewHeadless.navigateToPano(closestFrontier.panoId);
      // Reuse previously fetched data when possible, but confirm via current panorama call
      const newPanoData = closestPanoData ?? await this.streetViewHeadless.getCurrentPanorama();
      if (!closestPanoData || !closestPosition) {
        closestPosition = {
          lat: newPanoData.position.lat,
          lng: newPanoData.position.lng
        };
        closestDistance = this.coverage.calculateDistance(this.currentPosition, closestPosition);
      }

      this.currentPanoId = newPanoData.panoId;
      this.currentPosition = {
        lat: newPanoData.position.lat,
        lng: newPanoData.position.lng
      };

      // Teleport resets directional context until next navigation
      this.lastNavigationHeading = null;

      const newLinks = newPanoData.links || [];
      const visitInfo = this.coverage.addVisited(this.currentPanoId, this.currentPosition, newLinks);
      this.stepsSinceNewCell = visitInfo?.isNewCell ? 0 : this.stepsSinceNewCell + 1;

      const decisionReasoning = `Teleporting to unreachable frontier (${closestFrontier.panoId})`;

      this.recentMovements.push({
        from: previousPanoId,
        to: this.currentPanoId,
        fromPosition: previousPosition,
        toPosition: { ...this.currentPosition },
        heading: null,
        step: currentStep,
        reasoning: decisionReasoning
      });
      if (this.recentMovements.length > 20) {
        this.recentMovements.shift();
      }

      const stepData = {
        stepCount: currentStep,
        reasoning: decisionReasoning,
        panoId: this.currentPanoId,
        direction: 0,
        mode: 'pathfinding',
        screenshots: [],
        remainingPathSteps: null
      };

      const broadcastData = {
        ...stepData,
        newPosition: this.currentPosition,
        stats: this.coverage.getStats()
      };

      this.globalExploration.broadcast('move-decision', broadcastData);
      this.logger.log('exploration-step', {
        step: currentStep,
        from: previousPanoId,
        to: this.currentPanoId,
        decision: decisionReasoning,
        position: this.currentPosition,
        stats: this.coverage.getStats()
      });

      return stepData;
    } catch (error) {
      console.error(`Failed to teleport to frontier ${closestFrontier?.panoId || 'unknown'}:`, error.message);
      return null;
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
    this.lastNavigationHeading = null;  // Reset to null, not 0
    this.recentMovements = [];
    this.pathToFrontier = null;
    this.stepsSinceNewCell = 0;
    
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
