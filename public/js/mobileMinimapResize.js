/**
 * Mobile Minimap Resize Handler
 * Allows dragging the minimap tab to resize on mobile devices
 */

class MobileMinimapResize {
  constructor() {
    this.toggle = document.getElementById('minimapToggle');
    this.container = document.getElementById('minimapContainer');
    
    if (!this.toggle || !this.container) return;
    
    // State
    this.isExpanded = false;
    this.isDragging = false;
    this.currentWidth = 0;
    
    // Tab dimensions (collapsed state)
    this.tabWidth = 36;
    this.tabHeight = 48;
    
    // Initial minimap dimensions (what it starts at when sliding out)
    this.initialWidth = 250;
    this.initialHeight = 200;
    
    // Minimap scaling dimensions
    this.minWidth = 250;  // Same as initial for consistency
    this.maxWidth = window.innerWidth * 0.8; // 80% of screen
    this.minHeight = 200;  // Same as initial
    this.maxHeight = 300;
    
    // Touch tracking
    this.startX = 0;
    this.startWidth = 0;
    this.dragThreshold = 10; // Minimum movement to consider it a drag
    
    // Load saved position (ensure it's at least minWidth if saved)
    const saved = parseInt(localStorage.getItem('mobileMinimapWidth'));
    this.savedWidth = saved ? Math.max(saved, this.minWidth) : this.minWidth;
    
    // Only initialize on mobile
    if (window.innerWidth <= 768) {
      this.init();
    }
  }
  
  init() {
    // Remove old onclick handler
    this.toggle.onclick = null;
    
    // Add touch event listeners
    this.toggle.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
    this.toggle.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
    this.toggle.addEventListener('touchend', this.handleTouchEnd.bind(this));
    
    // Also handle mouse events for testing on desktop with device emulation
    this.toggle.addEventListener('mousedown', this.handleMouseDown.bind(this));
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('mouseup', this.handleMouseUp.bind(this));
    
    // Handle orientation changes
    window.addEventListener('orientationchange', () => {
      this.maxWidth = window.innerWidth * 0.8;
      if (this.currentWidth > this.maxWidth) {
        this.setWidth(this.maxWidth);
      }
    });
  }
  
  handleTouchStart(e) {
    e.preventDefault();
    const touch = e.touches[0];
    this.startDrag(touch.clientX);
  }
  
  handleMouseDown(e) {
    // Only for mobile view testing on desktop
    if (window.innerWidth > 768) return;
    e.preventDefault();
    this.startDrag(e.clientX);
  }
  
  startDrag(clientX) {
    this.startX = clientX;
    this.startWidth = this.currentWidth;
    this.isDragging = false; // Will be set to true if movement exceeds threshold
    
    // Add dragging class for visual feedback
    this.toggle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    
    // Remove transition during drag for smooth movement
    this.container.style.transition = 'none';
    this.toggle.style.transition = 'none';
  }
  
  handleTouchMove(e) {
    e.preventDefault();
    const touch = e.touches[0];
    this.handleDrag(touch.clientX);
  }
  
  handleMouseMove(e) {
    if (this.startX === 0) return;
    this.handleDrag(e.clientX);
  }
  
  handleDrag(clientX) {
    const deltaX = clientX - this.startX;
    
    // Check if this is a drag (not a tap)
    if (Math.abs(deltaX) > this.dragThreshold) {
      this.isDragging = true;
    }
    
    if (!this.isDragging) return;
    
    // Calculate new width based on drag distance
    let newWidth = this.startWidth + deltaX;
    
    // Apply constraints with elastic resistance
    if (newWidth < 0) {
      newWidth = 0;
    } else if (newWidth > this.maxWidth) {
      // Elastic resistance when above maximum
      const excess = newWidth - this.maxWidth;
      newWidth = this.maxWidth + (excess * 0.2); // Reduced movement past max
    }
    
    // During drag, directly update for smooth movement
    let containerWidth, containerHeight, containerLeft;
    
    if (newWidth <= 0) {
      // Fully collapsed - hide off-screen
      containerWidth = this.initialWidth;
      containerHeight = this.initialHeight;
      containerLeft = -this.initialWidth;
      this.toggle.style.left = '0px';
    } else if (newWidth < this.initialWidth) {
      // Sliding out phase - maintain initial size
      containerWidth = this.initialWidth;
      containerHeight = this.initialHeight;
      containerLeft = -this.initialWidth + newWidth;
      this.toggle.style.left = `${newWidth}px`;
    } else {
      // Scaling phase - minimap is fully visible
      containerLeft = 0;
      
      if (newWidth <= this.minWidth) {
        containerWidth = this.minWidth;
        containerHeight = this.minHeight;
      } else {
        containerWidth = newWidth;
        const scaleProgress = (newWidth - this.minWidth) / (this.maxWidth - this.minWidth);
        containerHeight = this.minHeight + (this.maxHeight - this.minHeight) * Math.min(1, scaleProgress);
      }
      
      this.toggle.style.left = `${containerWidth}px`;
    }
    
    // Apply dimensions
    this.container.style.left = `${containerLeft}px`;
    this.container.style.width = `${containerWidth}px`;
    this.container.style.height = `${containerHeight}px`;
    
    // Store current width for other operations
    this.currentWidth = newWidth;
    this.isExpanded = newWidth > 0;
  }
  
  handleTouchEnd(e) {
    const touch = e.changedTouches[0];
    this.endDrag(touch.clientX);
  }
  
  handleMouseUp(e) {
    if (this.startX === 0) return;
    this.endDrag(e.clientX);
  }
  
  endDrag(clientX) {
    const deltaX = clientX - this.startX;
    
    // Clean up
    this.toggle.classList.remove('dragging');
    document.body.style.userSelect = '';
    
    // Re-enable transitions
    this.container.style.transition = '';
    this.toggle.style.transition = '';
    
    if (!this.isDragging && Math.abs(deltaX) <= this.dragThreshold) {
      // It was a tap, not a drag
      this.toggleMinimap();
    } else {
      // It was a drag
      // Snap to bounds if needed
      if (this.currentWidth > 0 && this.currentWidth < this.minWidth) {
        // Snap to closed or min width
        if (this.currentWidth < this.minWidth / 2) {
          this.setWidth(0);
        } else {
          this.setWidth(this.minWidth);
        }
      } else if (this.currentWidth > this.maxWidth) {
        // Snap back to max
        this.setWidth(this.maxWidth);
      }
      
      // Save the position if expanded
      if (this.currentWidth > 0) {
        this.savedWidth = this.currentWidth;
        localStorage.setItem('mobileMinimapWidth', this.savedWidth);
      }
    }
    
    // Reset drag state
    this.startX = 0;
    this.isDragging = false;
  }
  
  setWidth(width, save = true) {
    this.currentWidth = width;
    this.isExpanded = width > 0;
    
    let containerWidth, containerHeight, containerLeft;
    
    if (width <= 0) {
      // Fully collapsed - hide minimap completely off-screen
      containerWidth = this.initialWidth;
      containerHeight = this.initialHeight;
      containerLeft = -this.initialWidth; // Hide completely off-screen
      this.toggle.style.left = '0px';
    } else if (width < this.initialWidth) {
      // Sliding out phase - maintain initial size, just slide into view
      containerWidth = this.initialWidth;
      containerHeight = this.initialHeight;
      // Slide out proportionally: from -initialWidth to 0
      containerLeft = -this.initialWidth + width;
      this.toggle.style.left = `${width}px`;
    } else {
      // Scaling phase - minimap is fully visible, now scale it
      containerLeft = 0; // Fully visible
      
      if (width <= this.minWidth) {
        // At minimum size
        containerWidth = this.minWidth;
        containerHeight = this.minHeight;
      } else {
        // Scale up from minimum to maximum
        containerWidth = width;
        const scaleProgress = (width - this.minWidth) / (this.maxWidth - this.minWidth);
        containerHeight = this.minHeight + (this.maxHeight - this.minHeight) * Math.min(1, scaleProgress);
      }
      
      this.toggle.style.left = `${containerWidth}px`;
    }
    
    // Apply dimensions and position
    this.container.style.left = `${containerLeft}px`;
    this.container.style.width = `${containerWidth}px`;
    this.container.style.height = `${containerHeight}px`;
    
    // Update classes
    if (this.isExpanded) {
      this.container.classList.add('expanded');
      this.toggle.classList.add('expanded');
    } else {
      this.container.classList.remove('expanded');
      this.toggle.classList.remove('expanded');
    }
    
    // Trigger map resize if needed
    if (window.mapManager && window.mapManager.map) {
      setTimeout(() => window.mapManager.map.resize(), 100);
    }
    
    // Save position if requested and expanded
    if (save && width > 0) {
      this.savedWidth = width;
      localStorage.setItem('mobileMinimapWidth', this.savedWidth);
    }
  }
  
  toggleMinimap() {
    if (this.isExpanded) {
      // Close
      this.setWidth(0, false);
    } else {
      // Open to saved width (ensure it's at least minWidth)
      const targetWidth = Math.max(this.savedWidth, this.minWidth);
      this.setWidth(targetWidth);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.mobileMinimapResize = new MobileMinimapResize();
  });
} else {
  window.mobileMinimapResize = new MobileMinimapResize();
}

// Also provide global toggle function for backward compatibility
window.toggleMinimap = function() {
  if (window.mobileMinimapResize) {
    window.mobileMinimapResize.toggleMinimap();
  }
};