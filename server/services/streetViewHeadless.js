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
  }

  async initialize() {
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
    
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 800, height: 600 });
    
    const html = `
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
            const startPanoId = '${process.env.START_PANO_ID || ''}';
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
              motionTrackingControl: false
            };
            
            // Use pano ID if available, otherwise use lat/lng
            if (startPanoId) {
              options.pano = startPanoId;
            } else {
              options.position = { 
                lat: ${parseFloat(process.env.START_LAT)}, 
                lng: ${parseFloat(process.env.START_LNG)}
              };
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
              if (typeof position === 'string') {
                service.getPanorama({ pano: position }, (data, status) => {
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
              } else {
                service.getPanorama({ location: position, radius: 50 }, (data, status) => {
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
              }
            });
          };
          
          window.navigateToPano = (panoId) => {
            panorama.setPano(panoId);
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
        </script>
        <script async defer 
          src="https://maps.googleapis.com/maps/api/js?key=${this.apiKey}&callback=initStreetView">
        </script>
      </body>
      </html>
    `;
    
    await this.page.setContent(html);
    await this.page.waitForFunction(() => window.streetViewReady === true, {
      timeout: 10000
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  async getPanorama(position) {
    const result = await this.page.evaluate((pos) => {
      return window.getPanorama(pos);
    }, position);
    
    if (!result) {
      throw new Error('No panorama found at location');
    }
    
    return result;
  }

  async getCurrentPanorama() {
    // Get the pano ID directly from the current panorama
    const currentPanoId = await this.page.evaluate(() => {
      return window.getCurrentPano();
    });
    
    if (!currentPanoId) {
      throw new Error('No current panorama available');
    }
    
    // Fetch the data for this specific pano ID
    return await this.getPanorama(currentPanoId);
  }

  async navigateToPano(panoId) {
    await this.page.evaluate((id) => {
      window.navigateToPano(id);
    }, panoId);
    
    this.currentPanoId = panoId;  // Track current position
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  async setHeading(heading) {
    await this.page.evaluate((h) => {
      window.setHeading(h);
    }, heading);
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  async getScreenshot() {
    return await this.page.screenshot({
      type: 'jpeg',
      quality: 80  // Reduced from 80 to save memory
    });
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
    
    // Close the current page
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Create a new page
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 800, height: 600 });
    
    // Reinitialize Street View
    const html = `
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
          
          window.streetViewReady = false;
          
          function initStreetView() {
            service = new google.maps.StreetViewService();
            panorama = new google.maps.StreetViewPanorama(
              document.getElementById('pano'),
              {
                position: { lat: 40.748817, lng: -73.985428 },
                pov: { heading: 0, pitch: 0 },
                zoom: 1,
                disableDefaultUI: true,
                clickToGo: false,
                linksControl: false
              }
            );
            
            window.navigateToPano = function(panoId) {
              panorama.setPano(panoId);
            };
            
            window.getCurrentPano = function() {
              return panorama.getPano();
            };
            
            window.setHeading = function(heading) {
              const currentPov = panorama.getPov();
              panorama.setPov({
                heading: heading,
                pitch: currentPov.pitch
              });
            };
            
            window.getPanorama = function(input) {
              return new Promise((resolve) => {
                const request = typeof input === 'string' 
                  ? { pano: input }
                  : { location: input, radius: 50 };
                
                service.getPanorama(request, (data, status) => {
                  if (status === 'OK') {
                    const result = {
                      panoId: data.location.pano,
                      position: {
                        lat: data.location.latLng.lat(),
                        lng: data.location.latLng.lng()
                      },
                      links: data.links.map(link => ({
                        pano: link.pano,
                        heading: link.heading,
                        description: link.description || ''
                      }))
                    };
                    resolve(result);
                  } else {
                    resolve(null);
                  }
                });
              });
            };
            
            window.streetViewReady = true;
          }
        </script>
        <script async defer 
          src="https://maps.googleapis.com/maps/api/js?key=${this.apiKey}&callback=initStreetView">
        </script>
      </body>
      </html>
    `;
    
    await this.page.setContent(html);
    await this.page.waitForFunction(() => window.streetViewReady === true, {
      timeout: 10000
    });
    
    // Navigate back to saved position
    if (savedPanoId) {
      await this.navigateToPano(savedPanoId);
    }
    
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
    
    // Close everything
    await this.close();
    
    // Force garbage collection
    if (global.gc) {
      global.gc();
    }
    
    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Reinitialize
    await this.initialize();
    
    // Navigate back to saved position
    if (savedPanoId) {
      await this.navigateToPano(savedPanoId);
    }
    
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