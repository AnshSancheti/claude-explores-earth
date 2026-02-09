import { createHmac } from 'crypto';

function getSecret() {
  const secret = process.env.URL_SIGNING_SECRET;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

function hmacFor(path, exp) {
  const secret = getSecret();
  if (!secret) return null;
  const data = `${path}:${exp}`;
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function signPath(path, ttlSeconds = 300) {
  const secret = getSecret();
  if (!secret) return path;
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const sig = hmacFor(path, exp);
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function maybeSignPath(path, ttlSeconds = 300) {
  return getSecret() ? signPath(path, ttlSeconds) : path;
}

export function verifySignature(path, exp, sig) {
  const secret = getSecret();
  if (!secret) return false;
  if (!exp || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum <= now) return false;
  const expected = hmacFor(path, expNum);
  return expected === sig;
}

