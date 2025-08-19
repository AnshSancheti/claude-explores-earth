# Fly.io Deployment Guide for DorAI

## Issue Fixed
The application was failing with "instance refused connection" because:
1. The server wasn't binding to `0.0.0.0` (was only listening on localhost)
2. Port configuration needed to be consistent (3000 for Fly.io)

## Changes Made
1. **Server now binds to 0.0.0.0**: Allows external connections
2. **PORT environment variable**: Set to 3000 in fly.toml
3. **NODE_ENV**: Set to production in fly.toml

## Pre-Deployment Checklist

### 1. Set Secrets in Fly.io
```bash
# CRITICAL: Set your API keys (regenerate them first!)
fly secrets set GOOGLE_MAPS_API_KEY="your-new-google-maps-key"
fly secrets set OPENAI_API_KEY="your-new-openai-key"

# Set admin control password
fly secrets set CONTROL_PASSWORD="your-secure-admin-password"

# Optional: Set admin API key for /runs protection
fly secrets set ADMIN_API_KEY="your-admin-api-key"

# Set starting location
fly secrets set START_LAT="40.748817"
fly secrets set START_LNG="-73.985428"
fly secrets set START_PANO_ID="PfZ-rW8bzPDXJsJuJqsBVA"

# Set other configuration
fly secrets set STEP_INTERVAL_MS="5000"
fly secrets set DECISION_HISTORY_LIMIT="100"
```

### 2. Verify Configuration
```bash
# Check your secrets are set (without revealing them)
fly secrets list

# Check fly.toml configuration
cat fly.toml
```

### 3. Deploy
```bash
# Deploy to Fly.io
fly deploy

# Monitor logs
fly logs

# Check app status
fly status
```

## Post-Deployment

### Monitor the Application
```bash
# Watch real-time logs
fly logs -f

# Check for errors
fly logs | grep ERROR

# Monitor memory usage
fly status
```

### Test Admin Authentication
1. Visit your app URL: `https://claude-explores-earth.fly.dev`
2. Click the lock icon in the header
3. Enter your CONTROL_PASSWORD
4. Verify control buttons appear and work

### Troubleshooting

#### If app won't start:
```bash
# Check logs for errors
fly logs

# SSH into the container
fly ssh console

# Check environment variables
printenv | grep -E "PORT|NODE_ENV"

# Test if server is running
curl http://localhost:3000
```

#### If authentication fails:
```bash
# Verify CONTROL_PASSWORD is set
fly secrets list | grep CONTROL_PASSWORD

# Update password if needed
fly secrets set CONTROL_PASSWORD="new-password"
```

#### If screenshots don't load:
- In production, only recent files (< 48 hours) are accessible
- Check browser console for 403 errors
- Verify /runs directory has proper permissions

## Security Notes

1. **API Keys**: Never commit API keys. Always use Fly secrets
2. **Admin Password**: Use a strong password for CONTROL_PASSWORD
3. **Rate Limiting**: Active in production (100 req/15min general, 30 req/15min API)
4. **XSS Protection**: HTML escaping is implemented
5. **Token Expiry**: Admin tokens expire after 1 hour

## Performance Optimization

### Scale if Needed
```bash
# Add more machines
fly scale count 2

# Increase memory
fly scale memory 2048

# Add regions
fly regions add lax
```

### Monitor Usage
- Google Maps API Console: Monitor Street View API usage
- OpenAI Dashboard: Check GPT API usage and costs
- Fly.io Dashboard: Monitor bandwidth and compute usage

## Important URLs
- App: `https://claude-explores-earth.fly.dev`
- Fly Dashboard: `https://fly.io/apps/claude-explores-earth`
- Logs: `fly logs -a claude-explores-earth`

## Rollback if Needed
```bash
# List releases
fly releases

# Rollback to previous version
fly deploy --image <previous-image-ref>
```