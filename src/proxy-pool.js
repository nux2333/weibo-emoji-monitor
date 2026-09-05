function parseProxyPool(rawValue) {
  return String(rawValue || '')
    .split(/[\r\n,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function toPlaywrightProxy(rawValue) {
  const raw = String(rawValue || '').trim();

  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const proxy = {
      server:
        `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`
    };

    if (parsed.username) {
      proxy.username = decodeURIComponent(parsed.username);
    }

    if (parsed.password) {
      proxy.password = decodeURIComponent(parsed.password);
    }

    return proxy;
  } catch {
    return { server: raw };
  }
}

function maskProxy(rawValue) {
  const raw = String(rawValue || '').trim();

  if (!raw) {
    return '-';
  }

  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;
  } catch {
    return raw.replace(/\/\/[^@]+@/, '//***@');
  }
}

class ProxyPool {
  constructor({
    rawPool = '',
    fallback = '',
    cooldownMs = 30 * 60 * 1000,
    name = 'proxy'
  } = {}) {
    const pool = parseProxyPool(rawPool);

    if (pool.length === 0 && String(fallback || '').trim()) {
      pool.push(String(fallback).trim());
    }

    this.items = pool;
    this.cooldownMs = Number(cooldownMs) || 30 * 60 * 1000;
    this.name = name;
    this.index = 0;
    this.cooldownUntil = new Map();
  }

  hasConfiguredProxy() {
    return this.items.length > 0;
  }

  acquire() {
    if (this.items.length === 0) {
      return {
        configured: false,
        raw: null,
        proxy: null,
        masked: 'LOCAL'
      };
    }

    const now = Date.now();

    for (let offset = 0; offset < this.items.length; offset++) {
      const idx = (this.index + offset) % this.items.length;
      const raw = this.items[idx];
      const until = this.cooldownUntil.get(raw) || 0;

      if (until <= now) {
        this.index = (idx + 1) % this.items.length;

        return {
          configured: true,
          raw,
          proxy: toPlaywrightProxy(raw),
          masked: maskProxy(raw)
        };
      }
    }

    const nextReadyAt = Math.min(
      ...this.items.map(raw => this.cooldownUntil.get(raw) || now)
    );

    return {
      configured: true,
      raw: null,
      proxy: null,
      masked: null,
      allCoolingDown: true,
      nextReadyAt
    };
  }

  markBlocked(rawValue) {
    const raw = String(rawValue || '').trim();

    if (!raw || !this.items.includes(raw)) {
      return null;
    }

    const until = Date.now() + this.cooldownMs;
    this.cooldownUntil.set(raw, until);
    return until;
  }
}

module.exports = {
  ProxyPool,
  parseProxyPool,
  toPlaywrightProxy,
  maskProxy
};
