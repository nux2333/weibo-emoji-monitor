const LIGHT_REQUEST_TIMEOUT_MS =
  Number(
    process.env.SUPERLIKE_LIGHT_REQUEST_TIMEOUT_MS
  )
  || 10000;

function isAbortError(error) {
  return !!error && (
    error.name === 'AbortError'
    || String(error.message || '')
      .toLowerCase()
      .includes('aborted')
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error =
      new Error(
        '本轮已被新一轮取消'
      );

    error.name =
      'AbortError';

    throw error;
  }
}

function buildLightProfileApiUrl(
  config,
  uid
) {
  const url =
    new URL(
      'https://m.weibo.cn/api/container/getIndex'
    );

  url.searchParams.set(
    'containerid',
    `${config.profileContainerId.replace(/_-_profile_inpage$/, '')}_-_profile_allbadge`
  );

  url.searchParams.set(
    'extparam',
    `target_uid#${uid}`
  );

  url.searchParams.set(
    'luicode',
    '10000011'
  );

  url.searchParams.set(
    'lfid',
    config.profileContainerId
  );

  url.searchParams.set(
    'launchid',
    '10000360-page_H5'
  );

  return url.toString();
}

function profileTextHasSuperLike(
  text
) {
  if (!text) {
    return false;
  }

  const lower =
    String(text)
      .toLowerCase();

  return (
    lower.includes(
      'fans_title_superlike.png'
    )
    ||
    lower.includes(
      'fans_title_superlike_on.png'
    )
    ||
    lower.includes(
      'chao_like'
    )
    ||
    String(text)
      .includes(
        '超LIKE'
      )
  );
}

async function checkSuperLikeByBrowser(
  context,
  config,
  uid,
  signal = null,
  logPrefix = '模式3'
) {
  throwIfAborted(signal);

  const apiUrl =
    buildLightProfileApiUrl(
      config,
      uid
    );

  let page = null;

  async function readCurrentPageResult(
    currentPage,
    response
  ) {
    const finalUrl =
      String(
        currentPage.url()
        || ''
      );

    const status =
      response
        ? response.status()
        : null;

    if (
      finalUrl.includes(
        'visitor.passport.weibo.cn'
      )
    ) {
      return {
        kind: 'visitor',
        finalUrl,
        status
      };
    }

    if (status === 418) {
      return {
        kind: 'blocked',
        status
      };
    }

    if (
      status !== null
      &&
      (
        status < 200
        ||
        status >= 300
      )
    ) {
      return {
        kind: 'http_error',
        status
      };
    }

    const body =
      await currentPage
        .locator('body')
        .innerText();

    let json = null;

    try {
      json =
        JSON.parse(
          body
        );
    } catch {
      return {
        kind: 'not_json',
        status,
        body
      };
    }

    if (
      Number(
        json?.ok
        ?? 0
      )
      !== 1
    ) {
      return {
        kind: 'api_error',
        status,
        body,
        json
      };
    }

    return {
      kind: 'ok',
      status,
      body
    };
  }

  try {
    page =
      await context.newPage();

    let response =
      await page.goto(
        apiUrl,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            LIGHT_REQUEST_TIMEOUT_MS
        }
      );

    throwIfAborted(signal);

    let parsed =
      await readCurrentPageResult(
        page,
        response
      );

    if (
      parsed.kind
      === 'visitor'
    ) {
      console.log(
        `[${logPrefix}][Visitor初始化] UID=${uid} | 首次跳转 visitor.passport，尝试建立游客Cookie`
      );

      try {
        await page.waitForTimeout(
          1500
        );

        throwIfAborted(signal);

        await page.goto(
          'https://m.weibo.cn/',
          {
            waitUntil:
              'domcontentloaded',
            timeout:
              LIGHT_REQUEST_TIMEOUT_MS
          }
        );

        await page.waitForTimeout(
          800
        );

        throwIfAborted(signal);

        response =
          await page.goto(
            apiUrl,
            {
              waitUntil:
                'domcontentloaded',
              timeout:
                LIGHT_REQUEST_TIMEOUT_MS
            }
          );

        parsed =
          await readCurrentPageResult(
            page,
            response
          );

      } catch (visitorError) {
        return {
          ok: false,
          blocked: false,
          hasSuperLike: null,
          status: null,
          url: apiUrl,
          message:
            `Visitor初始化失败：${visitorError.message}`
        };
      }
    }

    if (
      parsed.kind
      === 'visitor'
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          parsed.status,
        url:
          apiUrl,
        message:
          `profile_allbadge Visitor初始化后仍跳转 visitor.passport | ${parsed.finalUrl}`
      };
    }

    if (
      parsed.kind
      === 'blocked'
    ) {
      return {
        ok: false,
        blocked: true,
        hasSuperLike: null,
        status: 418,
        url: apiUrl,
        message:
          'profile_allbadge HTTP 418'
      };
    }

    if (
      parsed.kind
      === 'http_error'
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          parsed.status,
        url:
          apiUrl,
        message:
          `profile_allbadge HTTP ${parsed.status}`
      };
    }

    if (
      parsed.kind
      === 'not_json'
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          parsed.status,
        url:
          apiUrl,
        message:
          `profile_allbadge 返回的不是 JSON | ${String(parsed.body || '').slice(0, 500)}`
      };
    }

    if (
      parsed.kind
      === 'api_error'
    ) {
      return {
        ok: false,
        blocked: false,
        hasSuperLike: null,
        status:
          parsed.status,
        url:
          apiUrl,
        message:
          `profile_allbadge API ok=${parsed.json?.ok} | ${String(parsed.body || '').slice(0, 500)}`
      };
    }

    return {
      ok: true,
      blocked: false,
      hasSuperLike:
        profileTextHasSuperLike(
          parsed.body
        ),
      status:
        parsed.status,
      url:
        apiUrl
    };

  } catch (error) {
    if (
      signal?.aborted
      ||
      isAbortError(
        error
      )
    ) {
      const abortError =
        new Error(
          '本轮已被新一轮取消'
        );

      abortError.name =
        'AbortError';

      throw abortError;
    }

    return {
      ok: false,
      blocked: false,
      hasSuperLike: null,
      status: null,
      url: apiUrl,
      message:
        error?.message
        || String(error)
    };

  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = {
  buildLightProfileApiUrl,
  profileTextHasSuperLike,
  checkSuperLikeByBrowser
};
