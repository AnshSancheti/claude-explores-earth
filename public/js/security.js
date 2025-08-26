/**
 * Security utilities for the Scout application
 */

/**
 * Escapes HTML to prevent XSS attacks
 * @param {string} text - The text to escape
 * @returns {string} - The escaped HTML-safe text
 */
function escapeHtml(text) {
  if (typeof text !== 'string') {
    return text;
  }
  
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Sanitizes user input to prevent script injection
 * @param {any} input - The input to sanitize
 * @returns {any} - The sanitized input
 */
function sanitizeInput(input) {
  if (typeof input === 'string') {
    return escapeHtml(input);
  } else if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  } else if (typeof input === 'object' && input !== null) {
    const sanitized = {};
    for (const key in input) {
      if (input.hasOwnProperty(key)) {
        sanitized[key] = sanitizeInput(input[key]);
      }
    }
    return sanitized;
  }
  return input;
}

// Make functions available globally
window.escapeHtml = escapeHtml;
window.sanitizeInput = sanitizeInput;