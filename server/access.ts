import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { config, privateDir } from './config';
export const accessSettingsSchema = z.object({ salt: z.string().regex(/^[a-f0-9]{48}$/), passwordHash: z.string().regex(/^[a-f0-9]{64}$/), allowedLoginHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1) });
export type AccessSettings = z.infer<typeof accessSettingsSchema>;
export function hashIdentity(value: string) { return createHash('sha256').update(value.trim().toLowerCase()).digest('hex'); }
export function passwordHash(password: string, salt: string) { return scryptSync(password, salt, 32).toString('hex'); }
export class AccessBoundary {
  sessions = new Map<string, { identity: string; expires: number }>();
  attempts: number[] = [];
  readonly protected: boolean;
  readonly cookie: string;
  settings?: AccessSettings;
  constructor(public origin = config.publicOrigin, settings?: AccessSettings, protect = config.panelAuth) {
    this.protected = protect ?? !!origin; this.cookie = origin ? '__Host-linko-panel' : 'linko-local-panel';
    if (settings) this.settings = settings;
    // The tailnet identity allowlist is required even when the panel password is disabled.
    else if (origin || this.protected) { try { this.settings = accessSettingsSchema.parse(JSON.parse(readFileSync(join(privateDir, 'access.json'), 'utf8'))); } catch { /* fail closed; public status reports setup only */ } }
  }
  identity(req: Request) {
    if (!this.origin) return 'local';
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return '';
    if (req.headers.host !== new URL(this.origin).host) return '';
    // Trust only the loopback Tailscale Serve boundary. Do not enable Express trust-proxy.
    if (req.headers['x-forwarded-proto'] !== 'https') return '';
    if (req.headers['tailscale-funnel-request']) return '';
    const login = req.headers['tailscale-user-login'];
    if (typeof login !== 'string' || !login || login.includes(',')) return '';
    const identity = hashIdentity(login);
    return this.settings?.allowedLoginHashes.includes(identity) ? identity : '';
  }
  token(req: Request) {
    const cookies = req.headers.cookie || '';
    return cookies.split(';').map(v => v.trim()).find(v => v.startsWith(this.cookie + '='))?.slice(this.cookie.length + 1) || '';
  }
  session(req: Request) {
    if (!this.protected) return 'local';
    const token = this.token(req); if (!/^[a-f0-9]{64}$/.test(token)) return '';
    const key = hashIdentity(token), session = this.sessions.get(key);
    if (!session || session.expires < Date.now() || session.identity !== this.identity(req)) { this.sessions.delete(key); return ''; }
    return key;
  }
  middleware = (req: Request, res: Response, next: NextFunction) => {
    const identity = this.identity(req);
    if (!this.origin && !['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ message: 'This workspace only accepts its configured host.' });
    if (this.origin && !identity) return res.status(403).json({ message: 'This panel requires an authorized Tailscale identity through the HTTPS proxy.' });
    const expectedOrigin = this.origin || `${req.protocol}://${req.headers.host}`;
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) return res.status(403).json({ message: 'Cross-origin requests are disabled.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ message: 'Cross-site requests are disabled.' });
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
      if (req.method !== 'GET' && (req.headers['x-linko-request'] !== '1' || (this.origin && origin !== this.origin))) return res.status(403).json({ message: 'Open the protected panel to perform this action.' });
      const publicPaths = ['/api/auth/status', '/api/auth/login'];
      if (this.protected && !publicPaths.includes(req.path) && !this.session(req)) return res.status(401).json({ message: 'Sign in to the Linko panel first. This is separate from MyMarket login.' });
    }
    next();
  };
  status(req: Request) { return { protected: this.protected, signedIn: !this.protected || !!this.session(req), configured: !this.protected || !!this.settings, tailnet: !!this.origin }; }
  login(req: Request, res: Response) {
    this.attempts = this.attempts.filter(at => at > Date.now() - 10 * 60_000);
    if (this.attempts.length >= 6) return res.status(429).json({ message: 'Too many sign-in attempts. Wait ten minutes and try again.' });
    this.attempts.push(Date.now());
    const password = req.body?.password;
    if (!this.settings || typeof password !== 'string' || password.length < 12 || password.length > 256 || !timingSafeEqual(Buffer.from(passwordHash(password, this.settings.salt), 'hex'), Buffer.from(this.settings.passwordHash, 'hex'))) return res.status(401).json({ message: 'The panel password was not accepted.' });
    this.attempts = [];
    const token = randomBytes(32).toString('hex');
    this.sessions.set(hashIdentity(token), { identity: this.identity(req), expires: Date.now() + 8 * 60 * 60_000 });
    res.cookie(this.cookie, token, { httpOnly: true, secure: !!this.origin, sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60_000 });
    res.json({ signedIn: true });
  }
  logout(req: Request, res: Response) { this.sessions.delete(hashIdentity(this.token(req))); res.clearCookie(this.cookie, { httpOnly: true, secure: !!this.origin, sameSite: 'strict', path: '/' }); res.json({ signedIn: false }); }
}
