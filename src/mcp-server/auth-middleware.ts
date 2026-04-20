import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '../observability/logger.js';

function TimingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  burstSize?: number;
}

export interface AuthMiddlewareConfig {
  apiKey: string;
  rateLimit?: RateLimitConfig;
  trustedProxies?: string[];
  useProxyTrust?: boolean;
}

interface ClientRateLimitState {
  tokens: number;
  lastRefill: number;
  blockedUntil?: number;
}

/**
 * Authentication and rate limiting middleware for MCP endpoints
 */
export class AuthMiddleware {
  private apiKeyHash: Buffer;
  private rateLimitConfig: RateLimitConfig;
  private clientStates: Map<string, ClientRateLimitState> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private trustedProxies: string[] = [];
  private useProxyTrust: boolean = false;

  constructor(config: AuthMiddlewareConfig) {
    this.apiKeyHash = createHash('sha256').update(config.apiKey).digest();
    this.rateLimitConfig = {
      requestsPerMinute: config.rateLimit?.requestsPerMinute ?? 100,
      burstSize: config.rateLimit?.burstSize ?? 20,
    };
    this.trustedProxies = config.trustedProxies ?? [];
    this.useProxyTrust = config.useProxyTrust ?? false;

    this.cleanupInterval = setInterval(() => this.cleanupStaleEntries(), 60000);
    this.cleanupInterval.unref();
  }

  /**
   * Validate API key from request headers
   */
  validateApiKey(apiKey: string | undefined): boolean {
    if (!apiKey) {
      logger.warn('Missing API key in request');
      return false;
    }

    const inputHash = createHash('sha256').update(apiKey).digest();

    if (!TimingSafeEqual(inputHash, this.apiKeyHash)) {
      return false;
    }

    return true;
  }

  /**
   * Check rate limit for a client
   * Returns true if request is allowed, false if rate limited
   */
  checkRateLimit(clientId: string): { allowed: boolean; retryAfter?: number } {
    const config = this.rateLimitConfig;
    const now = Date.now();

    let state = this.clientStates.get(clientId);
    if (!state) {
      state = {
        tokens: config.burstSize ?? config.requestsPerMinute,
        lastRefill: now,
      };
      this.clientStates.set(clientId, state);
    }

    // Check if client is blocked
    if (state.blockedUntil && now < state.blockedUntil) {
      const retryAfter = Math.ceil((state.blockedUntil - now) / 1000);
      return { allowed: false, retryAfter };
    }

    // Refill tokens based on time elapsed
    const elapsed = now - state.lastRefill;
    const refillRate = config.requestsPerMinute / 60000; // tokens per ms
    const tokensToAdd = elapsed * refillRate;

    state.tokens = Math.min(
      config.burstSize ?? config.requestsPerMinute,
      state.tokens + tokensToAdd,
    );
    state.lastRefill = now;

    // Check if we have tokens available
    if (state.tokens >= 1) {
      state.tokens -= 1;
      state.blockedUntil = undefined;
      return { allowed: true };
    }

    // Rate limited - calculate retry after
    const retryAfter = Math.ceil(1000 / refillRate); // Time to get 1 token
    state.blockedUntil = now + retryAfter;

    logger.warn({ client_id: clientId, retry_after: retryAfter }, 'Rate limit exceeded');

    return { allowed: false, retryAfter };
  }

  /**
   * Get current rate limit status for a client
   */
  getRateLimitStatus(clientId: string): {
    remaining: number;
    limit: number;
    reset: number;
  } {
    const config = this.rateLimitConfig;
    const state = this.clientStates.get(clientId);
    const now = Date.now();

    if (!state) {
      return {
        remaining: config.burstSize ?? config.requestsPerMinute,
        limit: config.requestsPerMinute,
        reset: now + 60000,
      };
    }

    // Calculate current tokens
    const elapsed = now - state.lastRefill;
    const refillRate = config.requestsPerMinute / 60000;
    const currentTokens = Math.min(
      config.burstSize ?? config.requestsPerMinute,
      state.tokens + elapsed * refillRate,
    );

    return {
      remaining: Math.floor(currentTokens),
      limit: config.requestsPerMinute,
      reset: now + 60000,
    };
  }

  /**
   * Middleware function for Express-like frameworks
   */
  middleware(): (req: unknown, res: unknown, next: () => void) => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (req: any, res: any, next: () => void) => {
      const apiKey = req.headers?.['x-api-key'];
      const clientId = this.getClientId(req);

      // Validate API key
      if (!this.validateApiKey(apiKey)) {
        res.writeHead?.(401, { 'Content-Type': 'application/json' });
        res.end?.(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Check rate limit
      const rateLimitResult = this.checkRateLimit(clientId);
      if (!rateLimitResult.allowed) {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Retry-After': String(rateLimitResult.retryAfter ?? 60),
        };

        // Add rate limit headers
        const status = this.getRateLimitStatus(clientId);
        headers['X-RateLimit-Limit'] = String(status.limit);
        headers['X-RateLimit-Remaining'] = String(status.remaining);
        headers['X-RateLimit-Reset'] = String(status.reset);

        res.writeHead?.(429, headers);
        res.end?.(
          JSON.stringify({
            error: 'Rate limit exceeded',
            retry_after: rateLimitResult.retryAfter,
          }),
        );
        return;
      }

      // Add rate limit headers to successful responses
      const status = this.getRateLimitStatus(clientId);
      if (res.setHeader) {
        res.setHeader('X-RateLimit-Limit', String(status.limit));
        res.setHeader('X-RateLimit-Remaining', String(status.remaining));
        res.setHeader('X-RateLimit-Reset', String(status.reset));
      }

      next();
    };
  }

  /**
   * Stop the middleware and cleanup resources
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clean up stale client entries
   */
  private cleanupStaleEntries(): void {
    const now = Date.now();
    const oneHourAgo = now - 3600000; // 1 hour

    for (const [clientId, state] of this.clientStates.entries()) {
      if (state.lastRefill < oneHourAgo) {
        this.clientStates.delete(clientId);
      }
    }
  }

  /**
   * Reset rate limits for a specific client
   */
  resetClient(clientId: string): void {
    this.clientStates.delete(clientId);
    logger.info({ client_id: clientId }, 'Client rate limit reset');
  }

  /**
   * Extract client ID from request, respecting proxy settings
   */
  private getClientId(req: {
    ip?: string;
    headers?: Record<string, string | string[] | undefined>;
  }): string {
    if (this.useProxyTrust && this.trustedProxies.length > 0) {
      const forwardedFor = req.headers?.['x-forwarded-for'];
      if (forwardedFor) {
        const forwardedIps = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        const ips = forwardedIps.split(',').map((ip) => ip.trim());
        for (let i = ips.length - 1; i >= 0; i--) {
          if (this.isTrustedProxy(ips[i])) {
            continue;
          }
          return ips[i];
        }
        return ips[ips.length - 1];
      }
    }
    return req.ip ?? 'unknown';
  }

  /**
   * Check if an IP is a trusted proxy
   */
  private isTrustedProxy(ip: string): boolean {
    return this.trustedProxies.includes(ip);
  }

  /**
   * Get all active client rate limit states (for debugging)
   */
  getActiveClients(): string[] {
    return Array.from(this.clientStates.keys());
  }
}
