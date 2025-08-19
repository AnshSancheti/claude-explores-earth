/**
 * Admin Authentication Module
 * Handles password authentication and control button visibility
 */

class AdminAuth {
  constructor() {
    this.isAuthenticated = false;
    this.authToken = null;
    this.setupEventListeners();
    
    // Check for stored auth state (expires after 1 hour)
    this.checkStoredAuth();
  }

  setupEventListeners() {
    // Admin button click
    const adminBtn = document.getElementById('adminBtn');
    if (adminBtn) {
      adminBtn.addEventListener('click', () => this.showModal());
    }

    // Lock button click
    const lockBtn = document.getElementById('lockBtn');
    if (lockBtn) {
      lockBtn.addEventListener('click', () => this.lockControls());
    }

    // Enter key in password field
    const passwordInput = document.getElementById('passwordInput');
    if (passwordInput) {
      passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.authenticate();
        }
      });
    }

    // Click outside modal to close
    const modal = document.getElementById('passwordModal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeModal();
        }
      });
    }
  }

  checkStoredAuth() {
    const storedAuth = localStorage.getItem('adminAuth');
    if (storedAuth) {
      try {
        const { token, expires } = JSON.parse(storedAuth);
        if (Date.now() < expires) {
          this.authToken = token;
          this.isAuthenticated = true;
          this.showControls();
        } else {
          localStorage.removeItem('adminAuth');
        }
      } catch (e) {
        localStorage.removeItem('adminAuth');
      }
    }
  }

  showModal() {
    const modal = document.getElementById('passwordModal');
    const passwordInput = document.getElementById('passwordInput');
    const authError = document.getElementById('authError');
    
    if (modal) {
      modal.classList.remove('hidden');
      if (passwordInput) {
        passwordInput.value = '';
        passwordInput.focus();
      }
      if (authError) {
        authError.classList.add('hidden');
        authError.textContent = '';
      }
    }
  }

  closeModal() {
    const modal = document.getElementById('passwordModal');
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  async authenticate() {
    const passwordInput = document.getElementById('passwordInput');
    const authError = document.getElementById('authError');
    const submitBtn = document.querySelector('.btn-submit');
    
    if (!passwordInput || !passwordInput.value) {
      this.showError('Please enter a password');
      return;
    }

    // Disable submit button during authentication
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Authenticating...';
    }

    try {
      const response = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: passwordInput.value })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Authentication successful
        this.authToken = data.token;
        this.isAuthenticated = true;
        
        // Store auth with 1 hour expiry
        const authData = {
          token: data.token,
          expires: Date.now() + (60 * 60 * 1000) // 1 hour
        };
        localStorage.setItem('adminAuth', JSON.stringify(authData));
        
        // Show controls and close modal
        this.showControls();
        this.closeModal();
        
        // Show success message
        this.showSuccess('Admin controls unlocked');
      } else {
        // Authentication failed
        this.showError(data.error || 'Invalid password');
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch (error) {
      console.error('Authentication error:', error);
      this.showError('Connection error. Please try again.');
    } finally {
      // Re-enable submit button
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock';
      }
    }
  }

  showControls() {
    const adminBtn = document.getElementById('adminBtn');
    const controlButtons = document.getElementById('controlButtons');
    
    if (adminBtn && controlButtons) {
      // Hide admin button
      adminBtn.classList.add('hidden');
      
      // Show control buttons with animation
      controlButtons.classList.remove('hidden');
      controlButtons.classList.add('show');
      
      // Update admin icon to unlocked state
      const adminIcon = adminBtn.querySelector('svg');
      if (adminIcon) {
        adminIcon.innerHTML = '<path d="M10 2a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1V6a4 4 0 0 0-4-4zm-2 4a2 2 0 1 1 4 0v2H8V6z"/>';
      }
    }
  }

  lockControls() {
    const adminBtn = document.getElementById('adminBtn');
    const controlButtons = document.getElementById('controlButtons');
    
    if (adminBtn && controlButtons) {
      // Hide control buttons
      controlButtons.classList.remove('show');
      controlButtons.classList.add('hidden');
      
      // Show admin button
      adminBtn.classList.remove('hidden');
      
      // Clear authentication
      this.isAuthenticated = false;
      this.authToken = null;
      localStorage.removeItem('adminAuth');
      
      this.showSuccess('Controls locked');
    }
  }

  showError(message) {
    const authError = document.getElementById('authError');
    if (authError) {
      authError.textContent = message;
      authError.classList.remove('hidden');
    }
  }

  showSuccess(message) {
    // Create temporary success notification
    const notification = document.createElement('div');
    notification.className = 'admin-notification success';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // Static methods for inline event handlers
  static closeModal() {
    window.adminAuth.closeModal();
  }

  static authenticate() {
    window.adminAuth.authenticate();
  }
}

// Initialize admin auth when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.adminAuth = new AdminAuth();
  });
} else {
  window.adminAuth = new AdminAuth();
}

// Export for use in other modules
window.AdminAuth = AdminAuth;