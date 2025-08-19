/**
 * Frontend Street View Manager - Controls the visible Street View in the browser.
 * This is what users actually see and interact with.
 * It stays synchronized with the server's exploration through WebSocket events.
 * 
 * Note: The server has its own headless Street View (streetViewHeadless.js)
 * for capturing screenshots and navigation data for the AI.
 */
class StreetViewManager {
  constructor() {
    this.panorama = null;
    this.currentPanoId = null;
    // Start position will be set from server via setStartPosition()
    this.startPosition = null;
  }

  setStartPosition(position) {
    this.startPosition = position;
    if (this.panorama) {
      this.panorama.setPosition(position);
    }
  }

  initialize() {
    // Don't initialize until we have a start position
    if (!this.startPosition && !window.START_PANO_ID) {
      console.warn('Street View cannot initialize without start position');
      return;
    }
    
    // Check if we have a pano ID from the server
    const startPanoId = window.START_PANO_ID || null;
    const options = {
      pov: { heading: 0, pitch: 0 },
      zoom: 1,
      addressControl: true,
      linksControl: true,
      panControl: false,
      enableCloseButton: false,
      fullscreenControl: false,
      zoomControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: true,
      imageDateControl: false
    };
    
    if (startPanoId) {
      options.pano = startPanoId;
    } else if (this.startPosition) {
      options.position = this.startPosition;
    }
    
    this.panorama = new google.maps.StreetViewPanorama(
      document.getElementById('streetView'),
      options
    );
    
    // Listen for POV changes to update compass
    this.panorama.addListener('pov_changed', () => {
      const pov = this.panorama.getPov();
      this.updateCompass(pov.heading);
    });
  }
  
  updateCompass(heading) {
    const compassNeedle = document.getElementById('compassNeedle');
    if (compassNeedle) {
      compassNeedle.style.transform = `rotate(${heading}deg)`;
    }
  }

  updatePosition(panoId, heading) {
    if (panoId && panoId !== this.currentPanoId) {
      this.panorama.setPano(panoId);
      this.currentPanoId = panoId;
    }
    
    if (heading !== undefined) {
      this.panorama.setPov({
        heading: heading,
        pitch: 0
      });
      // Compass will update automatically via pov_changed listener
    }
  }

  reset() {
    this.panorama.setPosition(this.startPosition);
    this.panorama.setPov({
      heading: 0,
      pitch: 0
    });
    this.currentPanoId = null;
  }
}

window.StreetViewManager = StreetViewManager;
window.initStreetView = function() {
  window.streetViewReady = true;
};