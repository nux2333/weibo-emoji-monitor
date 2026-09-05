const fs = require('fs');

function parseProxyPool(rawValue) {
  return String(rawValue || '')
    .split(/[\r\n,;]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function loadProxyPoolFile(filePath) {
  if (!filePath) return [];

  try {
    if (!fs.existsSync(filePath)) return [];

    const json =
      JSON.parse(
        fs.readFileSync(filePath, 'utf8')
      );

    const list =
      Array.isArray(json)
        ? json
        : Array.isArray(json?.proxies)
          ? json.proxies
          : [];

    return list
      .map(item => {
        if (typeof item === 'string') {
          return item.trim();
        }

        const host =
          String(
            item?.host
            || item?.ip
            || item?.address
            || ''
          ).trim();

        const port =
          String(item?.port || '').trim();

        if (!host || !port) return '';

        const username =
          String(item?.username || '').trim();

        const password =
          String(item?.password || '').trim();

        const auth =
          username
            ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
            : '';

        return `http://${auth}${host}:${port}`;
      })
      .filter(Boolean);

  } catch (error) {
    console.error(
      `[ProxyPool] 读取代理池文件失败：${filePath} | ${error.message}`
    );

    return [];
  }
}

function shuffleArray(values) {
  const result =
    Array.from(values || []);

  for (
    let i = result.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      result[i],
      result[j]
    ] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

function toPlaywrightProxy(rawValue) {
  const raw =
    String(rawValue || '').trim();

  if (!raw) return null;

  try {
    const parsed =
      new URL(raw);

    const proxy = {
      server:
        `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`
    };

    if (parsed.username) {
      proxy.username =
        decodeURIComponent(
          parsed.username
        );
    }

    if (parsed.password) {
      proxy.password =
        decodeURIComponent(
          parsed.password
        );
    }

    return proxy;
  } catch {
    return {
      server: raw
    };
  }
}

function maskProxy(rawValue) {
  const raw =
    String(rawValue || '').trim();

  if (!raw) return '-';

  try {
    const parsed =
      new URL(raw);

    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}`;

  } catch {
    return raw.replace(
      /\/\/[^@]+@/,
      '//***@'
    );
  }
}

async function fetchScdnProxies({
  apiUrl =
    'https://proxy.scdn.io/api/get_proxy.php',
  protocol =
    'https',
  count =
    20,
  countryCode =
    '',
  timeoutMs =
    Number(
      process.env.SUPERLIKE_SCDN_TIMEOUT_MS
    )
    || 30 * 1000,
  retries =
    Number(
      process.env.SUPERLIKE_SCDN_RETRIES
    )
    || 3
} = {}) {
  const url =
    new URL(apiUrl);

  url.searchParams.set(
    'protocol',
    protocol
  );

  url.searchParams.set(
    'count',
    String(
      Math.max(
        1,
        Math.min(
          20,
          Number(count) || 20
        )
      )
    )
  );

  if (countryCode) {
    url.searchParams.set(
      'country_code',
      String(countryCode)
        .trim()
        .toUpperCase()
    );
  }

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url.toString(),
          {
            signal:
              controller.signal,

            headers: {
              Accept:
                'application/json, text/plain, */*',

              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
            }
          }
        );

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const json =
        await response.json();

      const list =
        Array.isArray(
          json?.data?.proxies
        )
          ? json.data.proxies
          : [];

      if (
        list.length === 0
      ) {
        throw new Error(
          'SCDN返回空代理列表'
        );
      }

      return list
        .map(value => {
          const raw =
            String(value || '')
              .trim();

          if (!raw) return '';

          return /^\w+:\/\//i.test(raw)
            ? raw
            : `http://${raw}`;
        })
        .filter(Boolean);

    } catch (error) {
      lastError =
        error;

      const message =
        error?.name === 'AbortError'
          ? `请求超时（${timeoutMs / 1000}秒）`
          : String(
              error?.message
              || error
            );

      console.log(
        `[ProxyPool:SCDN] 获取失败 ${attempt}/${retries}：${message}`
      );

      if (
        attempt < retries
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500 * attempt
            )
        );
      }

    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError
    || new Error(
      'SCDN代理获取失败'
    );
}


class ProxyPool {
  constructor({
    rawPool = '',
    fallback = '',
    filePath = '',
    cooldownMs =
      30 * 60 * 1000,
    name = 'proxy',
    dynamicSource = '',
    dynamicMinSize = 3,
    dynamicFetchCount = 20,
    dynamicProtocol = 'https',
    dynamicCountryCode = ''
  } = {}) {
    const pool = [
      ...loadProxyPoolFile(
        filePath
      ),
      ...parseProxyPool(
        rawPool
      )
    ];

    if (
      pool.length === 0
      &&
      String(
        fallback
        || ''
      ).trim()
    ) {
      pool.push(
        String(fallback).trim()
      );
    }

    this.items =
      shuffleArray(
        Array.from(
          new Set(pool)
        )
      );

    this.cooldownMs =
      Number(cooldownMs)
      ||
      30 * 60 * 1000;

    this.name =
      name;

    this.index =
      0;

    this.cooldownUntil =
      new Map();

    this.dynamicSource =
      String(
        dynamicSource
        || ''
      ).trim()
        .toLowerCase();

    this.dynamicMinSize =
      Math.max(
        1,
        Number(dynamicMinSize)
        || 3
      );

    this.dynamicFetchCount =
      Math.max(
        1,
        Math.min(
          20,
          Number(dynamicFetchCount)
          || 20
        )
      );

    this.dynamicProtocol =
      dynamicProtocol
      || 'https';

    this.dynamicCountryCode =
      dynamicCountryCode
      || '';

    this.lastDynamicFetchAt =
      0;

    this.dynamicFetchInFlight =
      null;

    if (
      this.items.length > 1
    ) {
      console.log(
        `[ProxyPool:${this.name}] 启动时已随机打乱代理顺序，共${this.items.length}个。`
      );
    }
  }

  hasConfiguredProxy() {
    return (
      this.items.length > 0
      ||
      this.dynamicSource === 'scdn'
    );
  }

  getAvailableCount() {
    const now =
      Date.now();

    return this.items
      .filter(
        raw =>
          (
            this.cooldownUntil.get(raw)
            || 0
          )
          <= now
      )
      .length;
  }

  async ensureDynamicPool() {
    if (
      this.dynamicSource
      !== 'scdn'
    ) {
      return;
    }

    if (
      this.getAvailableCount()
      >= this.dynamicMinSize
    ) {
      return;
    }

    if (
      this.dynamicFetchInFlight
    ) {
      await this.dynamicFetchInFlight;
      return;
    }

    /*
     * 避免短时间内反复打 SCDN API。
     */
    if (
      Date.now()
      -
      this.lastDynamicFetchAt
      <
      15000
    ) {
      return;
    }

    this.dynamicFetchInFlight =
      (async () => {
        this.lastDynamicFetchAt =
          Date.now();

        try {
          const fetched =
            await fetchScdnProxies({
              protocol:
                this.dynamicProtocol,

              count:
                this.dynamicFetchCount,

              countryCode:
                this.dynamicCountryCode
            });

          if (
            fetched.length === 0
          ) {
            console.log(
              `[ProxyPool:${this.name}] SCDN未返回可用候选代理。`
            );

            return;
          }

          const merged =
            Array.from(
              new Set([
                ...this.items,
                ...fetched
              ])
            );

          /*
           * 每次补池后重新随机一次，避免固定顺序。
           */
          this.items =
            shuffleArray(
              merged
            );

          this.index =
            0;

          console.log(
            `[ProxyPool:${this.name}] 从SCDN补充候选代理=${fetched.length}，当前池=${this.items.length}。`
          );

        } catch (error) {
          console.log(
            `[ProxyPool:${this.name}] SCDN代理获取失败：${error.message}`
          );

        } finally {
          this.dynamicFetchInFlight =
            null;
        }
      })();

    await this.dynamicFetchInFlight;
  }

  async acquire() {
    await this.ensureDynamicPool();

    if (
      this.items.length === 0
    ) {
      return {
        configured: false,
        raw: null,
        proxy: null,
        masked: 'LOCAL'
      };
    }

    const now =
      Date.now();

    for (
      let offset = 0;
      offset < this.items.length;
      offset++
    ) {
      const idx =
        (
          this.index
          + offset
        )
        %
        this.items.length;

      const raw =
        this.items[idx];

      const until =
        this.cooldownUntil.get(raw)
        || 0;

      if (
        until <= now
      ) {
        this.index =
          (
            idx + 1
          )
          %
          this.items.length;

        return {
          configured: true,
          raw,
          proxy:
            toPlaywrightProxy(raw),
          masked:
            maskProxy(raw)
        };
      }
    }

    /*
     * 全部冷却时再尝试向动态源补池一次。
     */
    if (
      this.dynamicSource === 'scdn'
    ) {
      this.lastDynamicFetchAt =
        0;

      await this.ensureDynamicPool();

      const retryNow =
        Date.now();

      for (
        let offset = 0;
        offset < this.items.length;
        offset++
      ) {
        const idx =
          (
            this.index
            + offset
          )
          %
          this.items.length;

        const raw =
          this.items[idx];

        if (
          (
            this.cooldownUntil.get(raw)
            || 0
          )
          <= retryNow
        ) {
          this.index =
            (
              idx + 1
            )
            %
            this.items.length;

          return {
            configured: true,
            raw,
            proxy:
              toPlaywrightProxy(raw),
            masked:
              maskProxy(raw)
          };
        }
      }
    }

    const nextReadyAt =
      Math.min(
        ...this.items.map(
          raw =>
            this.cooldownUntil.get(raw)
            || now
        )
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
    const raw =
      String(
        rawValue
        || ''
      ).trim();

    if (
      !raw
      ||
      !this.items.includes(raw)
    ) {
      return null;
    }

    const until =
      Date.now()
      +
      this.cooldownMs;

    this.cooldownUntil.set(
      raw,
      until
    );

    return until;
  }

  remove(rawValue) {
    const raw =
      String(
        rawValue
        || ''
      ).trim();

    if (!raw) return false;

    const before =
      this.items.length;

    this.items =
      this.items.filter(
        item =>
          item !== raw
      );

    this.cooldownUntil.delete(
      raw
    );

    if (
      this.index >=
      this.items.length
    ) {
      this.index = 0;
    }

    return (
      this.items.length
      <
      before
    );
  }
}

module.exports = {
  ProxyPool,
  parseProxyPool,
  loadProxyPoolFile,
  fetchScdnProxies,
  toPlaywrightProxy,
  maskProxy,
  shuffleArray
};
