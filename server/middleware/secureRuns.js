/**
 * Secure middleware for serving sensitive run data (screenshots and logs)
 * Provides multiple security options for production deployment
 */

import express from 'express';
import path from 'path';
import fs from 'fs';

/**
 * Option 1: Completely disable access in production
 */
export function disableInProduction() {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ 
        error: 'Access to run data is disabled in production' 
      });
    }
    next();
  };
}

/**
 * Option 2: API Key authentication
 */
export function requireApiKey() {
  return (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const validKey = process.env.ADMIN_API_KEY;
    
    if (!validKey) {
      console.error('ADMIN_API_KEY not configured');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }
    
    if (apiKey !== validKey) {
      return res.status(403).json({ 
        error: 'Invalid or missing API key' 
      });
    }
    
    next();
  };
}

/**
 * Option 3: Time-limited access URLs
 * Generate signed URLs that expire after a certain time
 */
export function signedUrlAccess() {
  const crypto = require('crypto');
  const secret = process.env.URL_SIGNING_SECRET || 'change-this-secret';
  
  return (req, res, next) => {
    const { signature, expires } = req.query;
    
    if (!signature || !expires) {
      return res.status(403).json({ 
        error: 'Missing signature or expiry' 
      });
    }
    
    const now = Date.now();
    if (now > parseInt(expires)) {
      return res.status(403).json({ 
        error: 'Link has expired' 
      });
    }
    
    // Verify signature
    const path = req.path;
    const hash = crypto
      .createHmac('sha256', secret)
      .update(`${path}:${expires}`)
      .digest('hex');
    
    if (hash !== signature) {
      return res.status(403).json({ 
        error: 'Invalid signature' 
      });
    }
    
    next();
  };
}

/**
 * Option 4: Serve only recent files (last N hours)
 * Prevents access to old screenshots while allowing recent ones
 */
export function recentFilesOnly(hoursAllowed = 24) {
  return (req, res, next) => {
    const filePath = req.path;
    const absolutePath = path.join(process.cwd(), 'runs', filePath);
    
    // Check if file exists
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    // Check file age
    const stats = fs.statSync(absolutePath);
    const ageInHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
    
    if (ageInHours > hoursAllowed) {
      return res.status(403).json({ 
        error: 'Access to old files is restricted' 
      });
    }
    
    next();
  };
}

/**
 * Option 5: IP whitelist
 */
export function ipWhitelist(allowedIps = []) {
  return (req, res, next) => {
    const clientIp = req.ip || req.connection.remoteAddress;
    
    // Allow localhost in development
    if (process.env.NODE_ENV !== 'production') {
      allowedIps.push('::1', '127.0.0.1', '::ffff:127.0.0.1');
    }
    
    if (!allowedIps.includes(clientIp)) {
      return res.status(403).json({ 
        error: 'Access denied from your IP address' 
      });
    }
    
    next();
  };
}

/**
 * Option 6: Combined security (recommended for production)
 * Combines multiple security measures
 */
export function productionSecurity() {
  return (req, res, next) => {
    // Always allow read access to screenshots for the decision log
    // In development, allow full access
    if (process.env.NODE_ENV !== 'production') {
      return express.static(path.join(process.cwd(), 'runs'))(req, res, next);
    }
    
    // In production, allow recent files only (last 48 hours)
    // This allows the decision log to show screenshots without authentication
    // but prevents access to very old data
    const filePath = req.path;
    const absolutePath = path.join(process.cwd(), 'runs', filePath);
    
    if (fs.existsSync(absolutePath)) {
      const stats = fs.statSync(absolutePath);
      const ageInHours = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
      
      if (ageInHours > 48) {
        return res.status(403).json({ 
          error: 'File too old to access' 
        });
      }
    }
    
    express.static(path.join(process.cwd(), 'runs'))(req, res, next);
  };
}

/**
 * Helper function to generate signed URLs
 */
export function generateSignedUrl(path, expiryMinutes = 60) {
  const crypto = require('crypto');
  const secret = process.env.URL_SIGNING_SECRET || 'change-this-secret';
  const expires = Date.now() + (expiryMinutes * 60 * 1000);
  
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${path}:${expires}`)
    .digest('hex');
  
  return `${path}?signature=${signature}&expires=${expires}`;
}