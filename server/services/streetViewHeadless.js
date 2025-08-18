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
  }

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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
                lat: ${parseFloat(process.env.START_LAT) || 40.748817}, 
                lng: ${parseFloat(process.env.START_LNG) || -73.985428}
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
                      pano_id: data.location.pano,
                      location: {
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
                      pano_id: data.location.pano,
                      location: {
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
      quality: 80
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}