const fs = require('fs');
const net = require('net');

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

    const content =
      fs.readFileSync(
        filePath,
        'utf8'
      );

    /*
     * 支持两种格式：
     * 1) JSON（旧 Webshare 配置）
     * 2) 纯文本，每行一个代理（weibo-good-proxies.txt）
     */
    if (
      String(filePath)
        .toLowerCase()
        .endsWith('.txt')
    ) {
      return Array.from(
        new Set(
          content
            .split(/\r?\n/)
            .map(line => {
              const raw =
                String(line || '')
                  .split('#')[0]
                  .trim();

              return raw;
            })
            .filter(Boolean)
        )
      );
    }

    const json =
      JSON.parse(
        content
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

function checkHttpsConnectProxy(
  rawValue,
  {
    targetHost = 'api.ipify.org',
    targetPort = 443,
    timeoutMs =
      Number(
        process.env.SUPERLIKE_PROXY_HEALTH_TIMEOUT_MS
      )
      || 5000
  } = {}
) {
  return new Promise(resolve => {
    let parsed;

    try {
      parsed =
        new URL(
          String(rawValue || '').trim()
        );
    } catch {
      resolve(false);
      return;
    }

    const host =
      parsed.hostname;

    const port =
      Number(
        parsed.port
      )
      || 80;

    if (!host || !port) {
      resolve(false);
      return;
    }

    const socket =
      net.connect({
        host,
        port
      });

    let settled =
      false;

    let responseText =
      '';

    const finish = value => {
      if (settled) {
        return;
      }

      settled = true;

      try {
        socket.destroy();
      } catch {
        // ignore
      }

      resolve(value);
    };

    socket.setTimeout(
      timeoutMs
    );

    socket.once(
      'connect',
      () => {
        const authHeader =
          parsed.username
            ? (
                'Proxy-Authorization: Basic '
                +
                Buffer.from(
                  `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`
                ).toString('base64')
                +
                '\r\n'
              )
            : '';

        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`
          +
          `Host: ${targetHost}:${targetPort}\r\n`
          +
          authHeader
          +
          'Proxy-Connection: keep-alive\r\n'
          +
          '\r\n'
        );
      }
    );

    socket.on(
      'data',
      chunk => {
        responseText +=
          chunk.toString(
            'latin1'
          );

        if (
          responseText.includes(
            '\r\n\r\n'
          )
        ) {
          const firstLine =
            responseText
              .split('\r\n')[0]
              || '';

          finish(
            /^HTTP\/\d(?:\.\d)?\s+200\b/i.test(
              firstLine
            )
          );
        }
      }
    );

    socket.once(
      'timeout',
      () => finish(false)
    );

    socket.once(
      'error',
      () => finish(false)
    );

    socket.once(
      'end',
      () => {
        if (!settled) {
          finish(false);
        }
      }
    );
  });
}

async function filterHealthyProxies(
  proxies,
  {
    concurrency =
      Number(
        process.env.SUPERLIKE_PROXY_HEALTH_CONCURRENCY
      )
      || 10
  } = {}
) {
  const list =
    Array.from(
      new Set(
        proxies
        || []
      )
    );

  const healthy =
    [];

  let cursor =
    0;

  async function worker() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        list.length
      ) {
        return;
      }

      const raw =
        list[index];

      if (
        await checkHttpsConnectProxy(
          raw
        )
      ) {
        healthy.push(
          raw
        );
      }
    }
  }

  const workerCount =
    Math.max(
      1,
      Math.min(
        Number(concurrency) || 10,
        list.length || 1
      )
    );

  await Promise.all(
    Array.from(
      {
        length:
          workerCount
      },
      () => worker()
    )
  );

  return healthy;
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
    dynamicCountryCode = '',
    dynamicHealthBatches =
      Number(
        process.env.SUPERLIKE_DYNAMIC_PROXY_HEALTH_BATCHES
      )
      || 3
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

    this.filePath =
      filePath
      || '';

    this.lastFileReloadAt =
      0;

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

    this.dynamicHealthBatches =
      Math.max(
        1,
        Number(
          dynamicHealthBatches
        )
        || 3
      );

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

  reloadFilePoolIfNeeded() {
    if (!this.filePath) {
      return;
    }

    const now =
      Date.now();

    if (
      now - this.lastFileReloadAt
      < 5000
    ) {
      return;
    }

    this.lastFileReloadAt =
      now;

    const fromFile =
      loadProxyPoolFile(
        this.filePath
      );

    if (
      fromFile.length === 0
    ) {
      return;
    }

    const oldSet =
      new Set(
        this.items
      );

    const merged =
      Array.from(
        new Set([
          ...this.items,
          ...fromFile
        ])
      );

    if (
      merged.length
      !== oldSet.size
    ) {
      this.items =
        shuffleArray(
          merged
        );

      this.index =
        0;

      console.log(
        `[ProxyPool:${this.name}] 健康代理文件已刷新，当前池=${this.items.length}。`
      );
    }
  }

  hasConfiguredProxy() {
    this.reloadFilePoolIfNeeded();

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
     * 避免多个调用同时狂打 SCDN。
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
          for (
            let batch = 1;
            batch <= this.dynamicHealthBatches;
            batch++
          ) {
            const fetched =
              await fetchScdnProxies({
                protocol:
                  this.dynamicProtocol,

                count:
                  this.dynamicFetchCount,

                countryCode:
                  this.dynamicCountryCode
              });

            console.log(
              `[ProxyPool:${this.name}] SCDN第${batch}/${this.dynamicHealthBatches}批候选=${fetched.length}，开始HTTPS CONNECT预检...`
            );

            const healthy =
              await filterHealthyProxies(
                fetched
              );

            console.log(
              `[ProxyPool:${this.name}] SCDN第${batch}批预检通过=${healthy.length}/${fetched.length}。`
            );

            if (
              healthy.length > 0
            ) {
              const merged =
                Array.from(
                  new Set([
                    ...this.items,
                    ...healthy
                  ])
                );

              this.items =
                shuffleArray(
                  merged
                );

              this.index =
                0;

              console.log(
                `[ProxyPool:${this.name}] 健康代理已加入池，当前池=${this.items.length}。`
              );

              if (
                this.getAvailableCount()
                >= this.dynamicMinSize
              ) {
                break;
              }
            }

            if (
              batch
              <
              this.dynamicHealthBatches
            ) {
              console.log(
                `[ProxyPool:${this.name}] 健康代理不足，立即获取下一批SCDN候选。`
              );
            }
          }

        } catch (error) {
          console.log(
            `[ProxyPool:${this.name}] SCDN代理获取/预检失败：${error.message}`
          );

        } finally {
          this.dynamicFetchInFlight =
            null;
        }
      })();

    await this.dynamicFetchInFlight;
  }

  async acquire() {
    this.reloadFilePoolIfNeeded();

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
  checkHttpsConnectProxy,
  filterHealthyProxies,
  toPlaywrightProxy,
  maskProxy,
  shuffleArray
};
