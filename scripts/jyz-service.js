const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR =
  process.env.WEIBO_JYZ_PROFILE
    ? path.resolve(process.env.WEIBO_JYZ_PROFILE)
    : path.join(ROOT, 'data', 'weibo-jyz-browser-profile');

const PORT =
  Number(process.env.WEIBO_JYZ_PORT)
  || 3011;

const HOST = '127.0.0.1';

let context = null;
let queue = Promise.resolve();

function extractExperience7d(currentInfo) {
  const text = String(currentInfo || '').trim();
  if (!text) return null;

  const match =
    text.match(/经验值\s*[：:]\s*(\d+)/)
    || text.match(/(\d+)\s*$/);

  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value)
    ? value
    : null;
}

async function ensureContext() {
  if (context) return context;

  context =
    await chromium.launchPersistentContext(
      PROFILE_DIR,
      {
        headless:
          process.env.WEIBO_JYZ_HEADLESS !== '0',
        viewport: {
          width: 1280,
          height: 900
        }
      }
    );

  console.log(
    '[JYZ Service] persistent profile ready: ' +
    PROFILE_DIR
  );

  return context;
}

async function getJyz(topicHash, uid) {
  const ctx =
    await ensureContext();

  let page = null;

  try {
    const pageId =
      '100808' + topicHash;

    const referer =
      new URL(
        'https://huati.weibo.cn/super/setting/icon'
      );

    referer.searchParams.set(
      'page_id',
      pageId
    );

    referer.searchParams.set(
      'icon_type',
      '1'
    );

    referer.searchParams.set(
      'union_id',
      'chao_like'
    );

    referer.searchParams.set(
      'param_uid',
      String(uid)
    );

    const apiUrl =
      new URL(
        'https://huati.weibo.cn/aj/setting/icon/getconfig'
      );

    apiUrl.searchParams.set('type', '1');
    apiUrl.searchParams.set(
      'union_id',
      'chao_like'
    );
    apiUrl.searchParams.set(
      'page_id',
      pageId
    );
    apiUrl.searchParams.set(
      'param_uid',
      String(uid)
    );

    page =
      await ctx.newPage();

    await page.goto(
      referer.toString(),
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          15000
      }
    ).catch(() => null);

    await page.waitForTimeout(
      300
    );

    const finalUrl =
      page.url();

    if (
      /passport\.weibo\.(cn|com)/i
        .test(finalUrl)
      ||
      /login/i.test(finalUrl)
    ) {
      return {
        ok: false,
        experience7d: null,
        message:
          'JYZ专用profile未登录huati：'
          + finalUrl
      };
    }

    const result =
      await page.evaluate(
        async url => {
          try {
            const response =
              await fetch(
                url,
                {
                  credentials:
                    'include',
                  cache:
                    'no-store',
                  headers: {
                    Accept:
                      'application/json, text/plain, */*',
                    'X-Requested-With':
                      'XMLHttpRequest'
                  }
                }
              );

            return {
              status:
                response.status,
              text:
                await response.text()
            };
          } catch (error) {
            return {
              status: null,
              text: '',
              error:
                error?.message
                || String(error)
            };
          }
        },
        apiUrl.toString()
      );

    if (
      !result
      ||
      result.error
    ) {
      return {
        ok: false,
        experience7d: null,
        message:
          result?.error
          || '页面内fetch失败'
      };
    }

    if (
      Number(result.status) < 200
      ||
      Number(result.status) >= 300
    ) {
      return {
        ok: false,
        experience7d: null,
        message:
          'HTTP '
          + result.status
      };
    }

    let json;

    try {
      json =
        JSON.parse(
          result.text
        );
    } catch (error) {
      return {
        ok: false,
        experience7d: null,
        message:
          'JSON解析失败：'
          + error.message
      };
    }

    if (
      Number(json?.code)
      !== 100000
    ) {
      return {
        ok: false,
        experience7d: null,
        message:
          'API code='
          + (json?.code ?? '-')
          + ' msg='
          + (json?.msg || '-')
      };
    }

    const currentInfo =
      json?.data?.current_info
      || '';

    const experience7d =
      extractExperience7d(
        currentInfo
      );

    if (
      experience7d === null
    ) {
      return {
        ok: false,
        experience7d: null,
        currentInfo,
        message:
          'current_info没有可解析经验值'
      };
    }

    return {
      ok: true,
      experience7d,
      currentInfo
    };
  } finally {
    if (
      page
      &&
      !page.isClosed()
    ) {
      await page.close()
        .catch(() => {});
    }
  }
}

function sendJson(
  res,
  status,
  payload
) {
  const text =
    JSON.stringify(
      payload
    );

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',
      'Content-Length':
        Buffer.byteLength(
          text
        )
    }
  );

  res.end(
    text
  );
}

const server =
  http.createServer(
    (req, res) => {
      const url =
        new URL(
          req.url,
          'http://'
          + HOST
          + ':'
          + PORT
        );

      if (
        req.method === 'GET'
        &&
        url.pathname === '/health'
      ) {
        sendJson(
          res,
          200,
          {
            ok: true
          }
        );
        return;
      }

      if (
        req.method === 'GET'
        &&
        url.pathname === '/jyz'
      ) {
        const topicHash =
          String(
            url.searchParams.get(
              'topicHash'
            )
            || ''
          ).trim();

        const uid =
          String(
            url.searchParams.get(
              'uid'
            )
            || ''
          ).trim();

        if (
          !topicHash
          ||
          !uid
        ) {
          sendJson(
            res,
            400,
            {
              ok: false,
              message:
                '缺少topicHash或uid'
            }
          );
          return;
        }

        queue =
          queue.then(
            () =>
              getJyz(
                topicHash,
                uid
              )
          );

        queue
          .then(
            result =>
              sendJson(
                res,
                result.ok
                  ? 200
                  : 503,
                result
              )
          )
          .catch(
            error =>
              sendJson(
                res,
                500,
                {
                  ok: false,
                  message:
                    error?.message
                    || String(error)
                }
              )
          );

        return;
      }

      sendJson(
        res,
        404,
        {
          ok: false,
          message:
            'Not Found'
        }
      );
    }
  );

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      '[JYZ Service] listening on http://'
      + HOST
      + ':'
      + PORT
    );
  }
);

async function shutdown() {
  server.close();
  if (context) {
    await context.close()
      .catch(() => {});
  }
  process.exit(0);
}

process.on(
  'SIGINT',
  () => void shutdown()
);

process.on(
  'SIGTERM',
  () => void shutdown()
);
