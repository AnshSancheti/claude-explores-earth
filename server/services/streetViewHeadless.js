import puppeteer from 'puppeteer';

/**
 * Headless Street View service for server-side operations.
 * This runs a hidden browser instance via Puppeteer to:
 * - Capture screenshots for AI analysis
 * - Get panorama data (links, available directions)
 * - Navigate between panoramas programmatically
 *
 * Note: This is NOT the Street View that users see in the browser.
 * The visible Street View is handled by public/js/streetview.js
 */
export class StreetViewHeadless {
  constructor() {
    this.browser = null;
    this.page = null;
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY;
    this.currentPanoId = null;  // Track current position for refresh
    this.refreshCount = 0;
    this.lastRefreshTime = Date.now();
    this.metadataTimeoutMs = this.#parseIntOr(process.env.STREETVIEW_METADATA_TIMEOUT_MS, 15000);
    this.navigationTimeoutMs = this.#parseIntOr(process.env.STREETVIEW_NAVIGATION_TIMEOUT_MS, 10000);
    this.screenshotTimeoutMs = this.#parseIntOr(process.env.STREETVIEW_SCREENSHOT_TIMEOUT_MS, 15000);
    this.refreshRestoreMaxDistanceMeters = this.#parseIntOr(process.env.REFRESH_RESTORE_MAX_DISTANCE_M, 1000);
  }

  #parseIntOr(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  #startPosition() {
    return {
      lat: parseFloat(process.env.START_LAT),
      lng: parseFloat(process.env.START_LNG)
    };
  }

  #withTimeout(promise, timeoutMs, label) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutHandle);
    });
  }

  #calculateDistance(pos1, pos2) {
    if (!pos1 || !pos2) return Infinity;
    const lat1 = Number(pos1.lat);
    const lng1 = Number(pos1.lng);
    const lat2 = Number(pos2.lat);
    const lng2 = Number(pos2.lng);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;

    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(deltaPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  #isValidPosition(position) {
    return (
      position &&
      Number.isFinite(Number(position.lat)) &&
      Number.isFinite(Number(position.lng))
    );
  }

  #buildStreetViewHtml(initial = {}) {
    const initialPanoId = initial.panoId || process.env.START_PANO_ID || '';
    const initialPosition = initial.position || this.#startPosition();
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; }
          #pano { width: 100vw; height: 100vh; }
        </style>
      </head>
      <body>
        <div id="pano"></div>
        <script>
          let panorama;
          let service;

          function initStreetView() {
            const initialPanoId = ${JSON.stringify(initialPanoId)};
            const initialPosition = ${JSON.stringify(initialPosition)};
            const options = {
              pov: { heading: 0, pitch: 0 },
              zoom: 1,
              addressControl: false,
              linksControl: false,
              panControl: false,
              enableCloseButton: false,
              fullscreenControl: false,
              zoomControl: false,
              motionTracking: false,
              motionTrackingControl: false,
              disableDefaultUI: true,
              clickToGo: false
            };

            if (initialPanoId) {
              options.pano = initialPanoId;
            } else if (initialPosition) {
              options.position = initialPosition;
            }

            panorama = new google.maps.StreetViewPanorama(
              document.getElementById('pano'),
              options
            );

            service = new google.maps.StreetViewService();

            window.streetViewReady = true;
          }

          window.getPanorama = (position) => {
            return new Promise((resolve) => {
              const request = typeof position === 'string'
                ? { pano: position }
                : { location: position, radius: 50 };

              service.getPanorama(request, (data, status) => {
                if (status === 'OK') {
                  resolve({
                    panoId: data.location.pano,
                    position: {
                      lat: data.location.latLng.lat(),
                      lng: data.location.latLng.lng()
                    },
                    links: data.links.map(link => ({
                      heading: link.heading,
                      description: link.description || '',
                      pano: link.pano
                    }))
                  });
                } else {
                  resolve(null);
                }
              });
            });
          };

          window.navigateToPano = (panoId, timeoutMs = 7000) => {
            return new Promise((resolve) => {
              const startPanoId = panorama.getPano();
              let settled = false;
              let settleTimer = null;
              let timeoutHandle = null;
              let listener = null;

              const cleanup = () => {
                if (settleTimer) {
                  clearTimeout(settleTimer);
                  settleTimer = null;
                }
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                if (listener) {
                  listener.remove();
                  listener = null;
                }
              };

              const finish = (reason) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                  requestedPanoId: panoId,
                  startPanoId: startPanoId || null,
                  settledPanoId: panorama.getPano() || null,
                  reason
                });
              };

              if (startPanoId && startPanoId === panoId) {
                finish('already-there');
                return;
              }

              listener = panorama.addListener('pano_changed', () => {
                const currentPanoId = panorama.getPano();
                if (!currentPanoId) return;

                if (currentPanoId === panoId) {
                  finish('exact-match');
                  return;
                }

                if (currentPanoId !== startPanoId) {
                  if (settleTimer) clearTimeout(settleTimer);
                  settleTimer = setTimeout(() => finish('alias-settled'), 100);
                }
              });

              timeoutHandle = setTimeout(() => finish('timeout'), timeoutMs);
              panorama.setPano(panoId);
            });
          };

          window.setHeading = (heading) => {
            panorama.setPov({
              heading: heading,
              pitch: 0
            });
          };

          window.getCurrentPano = () => {
            return panorama.getPano();
          };

          window.getCurrentPosition = () => {
            const pos = panorama.getPosition && panorama.getPosition();
            if (!pos) return null;
            return { lat: pos.lat(), lng: pos.lng() };
          };
        </script>
        <script async defer
          src="https://maps.googleapis.com/maps/api/js?key=${this.apiKey}&callback=initStreetView">
        </script>
      </body>
      </html>
    `;
  }

  async #createStreetViewPage(initial = {}) {
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 800, height: 600 });
    await this.page.setContent(this.#buildStreetViewHtml(initial));
    await this.page.waitForFunction(() => window.streetViewReady === true, {
      timeout: 10000
    });
  }

  async initialize(initial = {}) {
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // Use /tmp instead of /dev/shm
        '--disable-gpu',
        '--no-zygote',
        '--single-process',  // Run in single process mode
        '--max-old-space-size=512'  // Limit V8 memory
      ]
    });

    await this.#createStreetViewPage(initial);

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async getPanorama(position) {
    const result = await this.#withTimeout(
      this.page.evaluate((pos) => {
        return window.getPanorama(pos);
      }, position),
      this.metadataTimeoutMs,
      'Street View panorama lookup'
    );

    if (!result) {
      const label = typeof position === 'string'
        ? `pano:${position}`
        : `lat:${position?.lat},lng:${position?.lng}`;
      throw new Error(`No panorama found at location (${label})`);
    }

    return result;
  }

  async getCurrentPosition() {
    return await this.#withTimeout(
      this.page.evaluate(() => {
        if (typeof window.getCurrentPosition === 'function') {
          return window.getCurrentPosition();
        }
        return null;
      }),
      this.metadataTimeoutMs,
      'Street View current position lookup'
    );
  }

  async getCurrentPanorama() {
    // Get the pano ID directly from the current panorama
    const currentPanoId = await this.#withTimeout(
      this.page.evaluate(() => {
        return window.getCurrentPano();
      }),
      this.metadataTimeoutMs,
      'Street View current pano lookup'
    );

    // Prefer fetching by current pano ID, but fall back to current position when
    // old/stale pano IDs no longer resolve in Google metadata.
    if (currentPanoId) {
      try {
        const byPano = await this.getPanorama(currentPanoId);
        this.currentPanoId = byPano.panoId;
        return byPano;
      } catch (error) {
        console.warn(`Current pano lookup failed for ${currentPanoId}, falling back to position lookup: ${error.message}`);
      }
    }

    const currentPosition = await this.getCurrentPosition();
    if (currentPosition && Number.isFinite(currentPosition.lat) && Number.isFinite(currentPosition.lng)) {
      const byPosition = await this.getPanorama(currentPosition);
      this.currentPanoId = byPosition.panoId;
      return byPosition;
    }

    throw new Error('No current panorama available');
  }

  async navigateToPano(panoId) {
    const navResult = await this.#withTimeout(
      this.page.evaluate(async ({ id, timeoutMs }) => {
        return await window.navigateToPano(id, timeoutMs);
      }, { id: panoId, timeoutMs: this.navigationTimeoutMs }),
      this.navigationTimeoutMs + 1000,
      `Street View navigation to ${panoId}`
    );

    const settledPanoId = navResult?.settledPanoId || await this.#withTimeout(
      this.page.evaluate(() => window.getCurrentPano()),
      this.metadataTimeoutMs,
      'Street View settled pano lookup'
    );
    if (navResult?.reason === 'timeout') {
      console.warn(`Street View navigation timed out for ${panoId}; settled at ${settledPanoId || 'unknown'}`);
    } else if (settledPanoId && panoId !== settledPanoId) {
      console.log(`Street View canonicalized pano ${panoId} -> ${settledPanoId} (${navResult?.reason || 'unknown'})`);
    }

    this.currentPanoId = settledPanoId || panoId;
    return navResult;
  }

  /**
   * Navigate to a pano and return full panorama data in one operation.
   * Saves a roundtrip vs navigateToPano() + getCurrentPanorama().
   */
  async navigateAndGetPanorama(panoId) {
    await this.navigateToPano(panoId);
    const settledId = this.currentPanoId;
    let result;
    try {
      result = await this.getPanorama(settledId);
    } catch (err) {
      // Settled pano ID didn't resolve (alias issue); fall back to full getCurrentPanorama
      console.warn(`navigateAndGetPanorama: getPanorama(${settledId}) failed, falling back: ${err.message}`);
      result = await this.getCurrentPanorama();
    }
    // Keep headless state in sync with the canonical pano ID returned by Google
    this.currentPanoId = result.panoId;
    return result;
  }

  async setHeading(heading) {
    await this.page.evaluate((h) => {
      window.setHeading(h);
    }, heading);

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async getScreenshot() {
    return await this.#withTimeout(
      this.page.screenshot({
        type: 'jpeg',
        quality: 80  // Reduced from 80 to save memory
      }),
      this.screenshotTimeoutMs,
      'Street View screenshot'
    );
  }

  async #restoreAfterRefresh(savedPanoId, savedPosition, context) {
    if (savedPanoId) {
      await this.navigateToPano(savedPanoId);
    }

    let currentPano;
    try {
      currentPano = await this.getCurrentPanorama();
    } catch (error) {
      if (!this.#isValidPosition(savedPosition)) {
        throw error;
      }
      console.warn(`${context}: pano restore failed, trying saved position: ${error.message}`);
      currentPano = await this.getPanorama(savedPosition);
      await this.navigateToPano(currentPano.panoId);
      currentPano = await this.getCurrentPanorama();
    }

    if (savedPosition) {
      const distance = this.#calculateDistance(savedPosition, currentPano.position);
      if (distance > this.refreshRestoreMaxDistanceMeters && this.#isValidPosition(savedPosition)) {
        console.warn(`${context}: pano restore landed ${Math.round(distance)}m away, trying saved position.`);
        currentPano = await this.getPanorama(savedPosition);
        await this.navigateToPano(currentPano.panoId);
        currentPano = await this.getCurrentPanorama();
      }

      const restoredDistance = this.#calculateDistance(savedPosition, currentPano.position);
      if (restoredDistance > this.refreshRestoreMaxDistanceMeters) {
        throw new Error(
          `${context} restored to ${Math.round(restoredDistance)}m from saved position ` +
          `(expected pano ${savedPanoId || 'unknown'}, got ${currentPano.panoId})`
        );
      }
    }

    this.currentPanoId = currentPano.panoId;
    return currentPano;
  }

  /**
   * Refresh just the page (quick cleanup, ~2 seconds)
   * Keeps the browser instance but creates a new page
   */
  async refreshPage() {
    console.log(`🔄 Refreshing Puppeteer page (refresh #${this.refreshCount + 1})`);
    const memBefore = process.memoryUsage();

    // Save current position
    const savedPanoId = this.currentPanoId;
    const savedPosition = await this.getCurrentPosition().catch(() => null);

    // Close the current page
    if (this.page) {
      await this.page.close();
      this.page = null;
    }

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    await this.#createStreetViewPage({
      panoId: savedPanoId,
      position: savedPosition || this.#startPosition()
    });
    await this.#restoreAfterRefresh(savedPanoId, savedPosition, 'Page refresh');

    this.refreshCount++;
    this.lastRefreshTime = Date.now();

    const memAfter = process.memoryUsage();
    const memSaved = (memBefore.heapUsed - memAfter.heapUsed) / 1024 / 1024;
    console.log(`✅ Page refresh complete. Memory freed: ${memSaved.toFixed(1)}MB`);
  }

  /**
   * Full browser restart (thorough cleanup, ~5 seconds)
   * Completely restarts the browser instance
   */
  async refreshBrowser() {
    console.log(`🔄 Restarting Puppeteer browser (refresh #${this.refreshCount + 1})`);
    const memBefore = process.memoryUsage();

    // Save current position
    const savedPanoId = this.currentPanoId;
    const savedPosition = await this.getCurrentPosition().catch(() => null);

    // Close everything
    await this.close();

    // Force garbage collection
    if (global.gc) {
      global.gc();
    }

    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reinitialize directly at the saved panorama and validate we stayed nearby.
    await this.initialize({
      panoId: savedPanoId,
      position: savedPosition || this.#startPosition()
    });
    await this.#restoreAfterRefresh(savedPanoId, savedPosition, 'Browser refresh');

    this.refreshCount++;
    this.lastRefreshTime = Date.now();

    const memAfter = process.memoryUsage();
    const memSaved = (memBefore.rss - memAfter.rss) / 1024 / 1024;
    console.log(`✅ Browser restart complete. Memory freed: ${memSaved.toFixed(1)}MB`);
  }

  /**
   * Check if refresh is needed based on time or step count
   */
  shouldRefresh(stepCount) {
    const timeSinceRefresh = Date.now() - this.lastRefreshTime;
    const hourPassed = timeSinceRefresh > 60 * 60 * 1000;  // 1 hour
    const manySteps = stepCount > 0 && stepCount % 500 === 0;  // Every 500 steps

    return hourPassed || manySteps;
  }

  async close() {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
