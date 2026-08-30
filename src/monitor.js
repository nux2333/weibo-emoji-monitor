const { chromium } = require('playwright');

const {
  db,
  getMonitor,
  getMonitors,
  saveApiResponse,
  saveDailyStats,
  updateMonitorStatus,
  getAllComments
} = require('./db');

const { analyzeComments } = require('./emoji');
const { rebuildComments } = require('./rebuild-comments');


/**
 * ==========================================
 * 配置
 * ==========================================
 */

const DEFAULT_PAGE_SIZE = 100;

// 成功页之间随机等待 2～5 秒。
// 不再 0.5 秒疯狂翻页。
const PAGE_DELAY_MIN = 2000;
const PAGE_DELAY_MAX = 5000;

// 请求失败后固定等 30秒。
// ★重试同一页，不跳页。
const ERROR_RETRY_DELAY =  30 * 1000;

// 单次请求超时
const API_TIMEOUT = 60 * 1000;

// 打印评论 API 的 Request Headers。
// 稳定以后如果嫌日志多，可以改成 false。
const DEBUG_REQUEST_HEADERS = true;


const runningMonitors = new Set();


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function randomInt(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}


function todayString() {
  const d = new Date();

  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}


/**
 * ==========================================
 * URL
 * ==========================================
 */

function buildPageUrl(
  originalUrl,
  pageNum,
  pageSize
) {
  const url = new URL(originalUrl);

  url.searchParams.set(
    'page_num',
    String(pageNum)
  );

  url.searchParams.set(
    'page_size',
    String(pageSize)
  );

  return url.toString();
}


/**
 * ==========================================
 * 微博 Response 判断
 * ==========================================
 */

function isApiSuccess(data) {
  return (
    data &&
    typeof data === 'object' &&
    Number(data.code) === 100000
  );
}


function getApiNextState(data) {
  const value =
    data?.data?.is_next ??
    data?.is_next;

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return Number(value) === 1;
}


function getResultCount(data) {
  const result =
    data?.data?.result ??
    data?.result;

  return Array.isArray(result)
    ? result.length
    : 0;
}


/**
 * ==========================================
 * 续跑判断
 * ==========================================
 */

function getLatestApiResponseRecord(
  monitorId
) {
  return db.prepare(`
    SELECT
      id,
      monitor_id,
      page_num,
      api_url,
      http_status,
      response_json,
      error_message,
      created_at
    FROM api_responses
    WHERE monitor_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(monitorId);
}


function responseRecordIsSuccess(record) {
  if (!record) {
    return false;
  }

  if (
    record.error_message !== null &&
    record.error_message !== undefined &&
    String(record.error_message).trim() !== ''
  ) {
    return false;
  }

  if (!record.response_json) {
    return false;
  }

  try {
    const data =
      JSON.parse(
        record.response_json
      );

    return isApiSuccess(data);

  } catch {
    return false;
  }
}


function responseRecordIsLastPage(record) {
  if (
    !responseRecordIsSuccess(record)
  ) {
    return false;
  }

  try {
    const data =
      JSON.parse(
        record.response_json
      );

    return (
      getApiNextState(data) === false
    );

  } catch {
    return false;
  }
}


/**
 * 上一轮 success：
 *   新一轮 page1
 *
 * 上一轮未结束：
 *
 * latest error page59
 *   => page59
 *
 * latest success page59
 *   => page60
 *
 * latest success + is_next=0
 *   => API 已经抓完，直接 rebuild
 */
function getResumeState(monitor) {

  /**
   * 上一轮完整成功：
   * 新的一轮重新从第一页开始。
   */
  if (
    monitor.last_status === 'success'
  ) {
    return {
      startPage: 1,

      responsesAlreadyComplete:
        false,

      reason:
        '上一轮已经完整成功，本轮从第 1 页开始'
    };
  }


  const latest =
    getLatestApiResponseRecord(
      monitor.id
    );


  if (!latest) {
    return {
      startPage: 1,

      responsesAlreadyComplete:
        false,

      reason:
        '没有历史 response，从第 1 页开始'
    };
  }


  /**
   * ★最新记录失败。
   *
   * 不管失败多少次，
   * 永远还是这一页。
   */
  if (
    !responseRecordIsSuccess(latest)
  ) {
    return {
      startPage:
        Number(latest.page_num),

      responsesAlreadyComplete:
        false,

      reason:
        `最新记录第 ${latest.page_num} 页失败，从第 ${latest.page_num} 页重试`
    };
  }


  /**
   * 最后一页已经成功抓完，
   * 但服务可能在 rebuild 前被关闭。
   */
  if (
    responseRecordIsLastPage(latest)
  ) {
    return {
      startPage:
        Number(latest.page_num),

      responsesAlreadyComplete:
        true,

      reason:
        `第 ${latest.page_num} 页已经成功且 is_next=0，直接继续 rebuild`
    };
  }


  /**
   * 最新成功页还有下一页。
   */
  return {
    startPage:
      Number(latest.page_num) + 1,

    responsesAlreadyComplete:
      false,

    reason:
      `第 ${latest.page_num} 页已经成功，从第 ${Number(latest.page_num) + 1} 页继续`
  };
}


/**
 * ==========================================
 * 单页 API 请求
 * ==========================================
 */

async function fetchCommentPage(
  page,
  originalUrl,
  monitorId,
  pageNum,
  pageSize
) {

  const apiUrl =
    buildPageUrl(
      originalUrl,
      pageNum,
      pageSize
    );


  console.log('');
  console.log(
    `请求第 ${pageNum} 页：${apiUrl}`
  );


  let responseSaved = false;


  try {

    const result =
      await page.evaluate(

        async ({
          url,
          timeout
        }) => {

          const controller =
            new AbortController();


          const timer =
            setTimeout(
              () =>
                controller.abort(),
              timeout
            );


          try {

            const response =
              await fetch(
                url,
                {
                  method: 'GET',

                  credentials:
                    'include',

                  cache:
                    'no-store',

                  headers: {
                    Accept:
                      'application/json, text/plain, */*'
                  },

                  signal:
                    controller.signal
                }
              );


            const text =
              await response.text();


            let data;


            try {
              data =
                JSON.parse(text);

            } catch {
              return {
                ok: false,

                type:
                  'invalid_json',

                status:
                  response.status,

                responseText:
                  text,

                error:
                  `返回内容不是 JSON：${text.slice(0, 1000)}`
              };
            }


            return {
              ok: true,

              status:
                response.status,

              data
            };


          } catch (error) {

            return {
              ok: false,

              type:
                error.name ===
                'AbortError'
                  ? 'timeout'
                  : 'network',

              status:
                null,

              responseText:
                null,

              error:
                error.message ||
                String(error)
            };


          } finally {

            clearTimeout(timer);
          }

        },

        {
          url: apiUrl,
          timeout: API_TIMEOUT
        }
      );


    /**
     * ======================================
     * HTTP Response 正常收到
     * ======================================
     */
    if (result.ok) {

      /**
       * HTTP 层失败。
       */
      if (
        result.status < 200 ||
        result.status >= 300
      ) {

        const errorMessage =
          `HTTP 状态异常：${result.status}`;


        saveApiResponse({
          monitorId,
          pageNum,
          apiUrl,

          httpStatus:
            result.status,

          responseData:
            result.data,

          errorMessage
        });


        responseSaved = true;


        throw new Error(
          errorMessage
        );
      }


      /**
       * ==================================
       * ★微博业务结果
       * ==================================
       *
       * HTTP 200 不代表成功。
       *
       * 只有 code = 100000 才成功。
       */
      if (
        !isApiSuccess(
          result.data
        )
      ) {

        let errorJson;

        try {
          errorJson =
            JSON.stringify(
              result.data
            );

        } catch {
          errorJson =
            String(result.data);
        }


        /**
         * 你的规则：
         *
         * response_json：
         * 保存完整 JSON
         *
         * error_message：
         * 同样保存完整 JSON
         */
        saveApiResponse({
          monitorId,
          pageNum,
          apiUrl,

          httpStatus:
            result.status,

          responseData:
            result.data,

          errorMessage:
            errorJson
        });


        responseSaved = true;


        throw new Error(
          `微博 API 业务错误：${errorJson}`
        );
      }


      /**
       * ==================================
       * 真正成功
       * ==================================
       */
      saveApiResponse({
        monitorId,
        pageNum,
        apiUrl,

        httpStatus:
          result.status,

        responseData:
          result.data,

        errorMessage:
          null
      });


      responseSaved = true;


      return result.data;
    }


    /**
     * ======================================
     * 网络 / Timeout / JSON 错误
     * ======================================
     */

    let errorMessage =
      result.error ||
      '未知请求错误';


    if (
      result.type === 'timeout'
    ) {
      errorMessage =
        `请求超时（${API_TIMEOUT / 1000} 秒）`;

    } else if (
      result.type === 'network'
    ) {
      errorMessage =
        `网络错误：${errorMessage}`;
    }


    let responseData = null;


    if (
      result.responseText !== null &&
      result.responseText !== undefined
    ) {
      responseData = {
        raw_response:
          result.responseText
      };
    }


    saveApiResponse({
      monitorId,
      pageNum,
      apiUrl,

      httpStatus:
        result.status,

      responseData,

      errorMessage
    });


    responseSaved = true;


    throw new Error(
      errorMessage
    );


  } catch (error) {

    /**
     * 防止同一个错误保存两次。
     */
    if (!responseSaved) {

      const errorMessage =
        error.message ||
        String(error);


      saveApiResponse({
        monitorId,
        pageNum,
        apiUrl,

        httpStatus:
          null,

        responseData:
          null,

        errorMessage:
          `Playwright/API 异常：${errorMessage}`
      });
    }


    throw error;
  }
}


/**
 * ==========================================
 * 创建真实 Chrome
 * ==========================================
 *
 * 关键：
 *
 * 不再：
 *
 * headless: true
 *
 * 因为你刚才实际日志已经显示：
 *
 * sec-ch-ua:
 * "HeadlessChrome";v="151"
 *
 * 这里直接调用电脑安装的 Google Chrome。
 */
async function createBrowser() {

  console.log('');
  console.log(
    '启动 Playwright Chromium...'
  );

  return chromium.launch({
    headless: false,

    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

/**
 * ==========================================
 * 抓取所有 Response
 * ==========================================
 */

async function fetchAllResponses(
  url,
  monitorId,
  startPage
) {

  const browser =
    await createBrowser();


  /**
   * 保留你成功浏览器请求的移动端环境：
   *
   * Android 15
   * Pixel 9
   * Chrome 151
   *
   * channel=chrome 会让 sec-ch-ua
   * 使用真正 Google Chrome，
   * 而不是 HeadlessChrome。
   */
  const context =
    await browser.newContext({

      viewport: {
        width: 412,
        height: 915
      },

      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/151.0.0.0 Mobile Safari/537.36',

      isMobile: true,

      hasTouch: true,

      deviceScaleFactor: 2.625,

      locale: 'zh-CN',

      extraHTTPHeaders: {

        'sec-ch-ua':
          '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',

        'sec-ch-ua-mobile':
          '?1',

        'sec-ch-ua-platform':
          '"Android"',

        'accept':
          'application/json, text/plain, */*',

        'accept-language':
          'zh-CN'
      }
    });


  let page =
	  await context.newPage();


  let pageNum =
    Number(startPage);


  let successPages = 0;


  /**
   * Debug：
   *
   * 看真实发出去的 API Headers。
   */
  if (
    DEBUG_REQUEST_HEADERS
  ) {

    page.on(
      'request',
      request => {

        if (
          !request
            .url()
            .includes(
              '/aj/shop/product/comments'
            )
        ) {
          return;
        }


        console.log('');
        console.log(
          '========== PROGRAM REQUEST =========='
        );

        console.log(
          'URL:',
          request.url()
        );

        console.log(
          JSON.stringify(
            request.headers(),
            null,
            2
          )
        );

        console.log(
          '====================================='
        );
      }
    );
  }


  try {

    console.log('');
    console.log(
      '================================'
    );

    console.log(
      `开始抓取：${url}`
    );

    console.log(
      `开始页：${pageNum}`
    );

    console.log(
      '浏览器：Google Chrome'
    );

    console.log(
      '模式：headed'
    );

    console.log(
      '成功页等待：随机 2～5 秒'
    );

    console.log(
      '失败页等待：3 分钟'
    );

    console.log(
      '抓取阶段只写 api_responses'
    );

    console.log(
      '================================'
    );


    /**
     * 先打开原 URL，
     * 建立页面 / Cookie / 同源环境。
     */
	try {

	  await page.goto(
	    'https://daogou.e.weibo.com/',
	    {
	      waitUntil: 'domcontentloaded',
	      timeout: 60000
	    }
	  );

	} catch (error) {

	  console.log(
	    `初始化微博页面失败，但继续尝试 API：${error.message}`
	  );
	}

	await sleep(2000);

    /**
     * ======================================
     * 主分页循环
     * ======================================
     */
    while (true) {

      let data;


      /**
       * ==================================
       * 当前页 Retry Loop
       * ==================================
       *
       * ★这里绝对不会 pageNum++
       */
      while (true) {

        try {

          data =
            await fetchCommentPage(
              page,
              url,
              monitorId,
              pageNum,
              DEFAULT_PAGE_SIZE
            );


          /**
           * 当前页成功。
           */
          break;


        } catch (error) {

          console.error('');
          console.error(
            `第 ${pageNum} 页失败`
          );

          console.error(
            error.message
          );

          console.error(
            `失败 URL：${buildPageUrl(
              url,
              pageNum,
              DEFAULT_PAGE_SIZE
            )}`
          );

          console.error(
            '失败 response 已保存到 api_responses'
          );

          console.error(
            `30秒后继续重试第 ${pageNum} 页`
          );


          /**
           * ★失败不加页。
           */
          await sleep(
            ERROR_RETRY_DELAY
          );


          /**
           * 重新进入原页面，
           * 刷新当前浏览器环境。
           */
          try {

            console.log('');
            console.log(
              '重新刷新页面环境...'
            );


			try {

			  if (
			    page.isClosed()
			  ) {

			    console.log(
			      '页面已经关闭，重新创建页面'
			    );

			    page =
			      await context.newPage();
			  }


			  await page.goto(
			    'https://daogou.e.weibo.com/',
			    {
			      waitUntil:
			        'domcontentloaded',

			      timeout:
			        60000
			    }
			  );


			} catch (refreshError) {

			  console.error(
			    `刷新微博页面环境失败：${refreshError.message}`
			  );
			}


			await sleep(
			  randomInt(
			    2000,
			    4000
			  )
			);


          } catch (
            refreshError
          ) {

            console.error(
              `重新打开页面失败：${refreshError.message}`
            );
          }


          /**
           * 回到 while(true)
           *
           * ★还是当前 pageNum
           */
        }
      }


      /**
       * ======================================
       * 当前页成功
       * ======================================
       */

      successPages++;


      const resultCount =
        getResultCount(data);


      console.log('');
      console.log(
        `第 ${pageNum} 页成功，result=${resultCount} 条`
      );


      const hasNext =
        getApiNextState(data);


      /**
       * is_next=0：
       * 全部抓完。
       */
      if (
        hasNext === false
      ) {

        console.log('');
        console.log(
          `第 ${pageNum} 页 is_next=0`
        );

        console.log(
          '所有 response 已抓取完成'
        );


        return {
          successPages,

          lastPage:
            pageNum
        };
      }


      /**
       * 没有 is_next，
       * 同时 result 为空：
       *
       * 防止死循环。
       */
      if (
        hasNext === null &&
        resultCount === 0
      ) {

        console.log('');
        console.log(
          'API 没有 is_next 且 result=0，停止'
        );


        return {
          successPages,

          lastPage:
            pageNum
        };
      }


      /**
       * ==================================
       * ★唯一 pageNum++ 的地方
       * ==================================
       *
       * 只有成功 response 才能走到这里。
       */
      pageNum++;


      /**
       * 不再固定 500ms。
       *
       * 随机 2～5 秒。
       */
      const delay =
        randomInt(
          PAGE_DELAY_MIN,
          PAGE_DELAY_MAX
        );


      console.log(
        `等待 ${(delay / 1000).toFixed(1)} 秒后请求第 ${pageNum} 页`
      );


      await sleep(delay);
    }


  } finally {

    await context
      .close()
      .catch(() => {});


    await browser
      .close()
      .catch(() => {});
  }
}


/**
 * ==========================================
 * 单个 Monitor
 * ==========================================
 */

async function runMonitor(
  monitorId
) {

  if (
    runningMonitors.has(
      monitorId
    )
  ) {

    console.log(
      `Monitor ${monitorId} 已经在运行`
    );

    return;
  }


  /**
   * ★必须先读取旧 last_status，
   * 再 update running。
   */
  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {
    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (!monitor.enabled) {

    console.log(
      `Monitor ${monitorId} 已停用`
    );

    return;
  }


  runningMonitors.add(
    monitorId
  );


  try {

    console.log('');
    console.log(
      `========== Monitor ${monitorId} ==========`
    );

    console.log(
      `名称：${monitor.name}`
    );

    console.log(
      `上一次状态：${monitor.last_status || '无'}`
    );


    /**
     * ======================================
     * 先判断续跑点
     * ======================================
     */
    const resume =
      getResumeState(
        monitor
      );


    console.log(
      `续跑判断：${resume.reason}`
    );


    /**
     * 判断完成以后，
     * 才更新 running。
     */
    updateMonitorStatus(
      monitorId,
      'running'
    );


    /**
     * ======================================
     * STEP 1：抓 api_responses
     * ======================================
     */
    if (
      !resume.responsesAlreadyComplete
    ) {

      const fetchResult =
        await fetchAllResponses(
          monitor.url,
          monitorId,
          resume.startPage
        );


      console.log('');
      console.log(
        '================================'
      );

      console.log(
        'response 抓取完成'
      );

      console.log(
        `本次成功页数：${fetchResult.successPages}`
      );

      console.log(
        `最后页：${fetchResult.lastPage}`
      );

      console.log(
        '================================'
      );


    } else {

      console.log('');
      console.log(
        'API response 已经全部抓完'
      );

      console.log(
        '跳过请求，直接 rebuild comments'
      );
    }


    /**
     * ======================================
     * STEP 2：统一生成 comments
     * ======================================
     */

    console.log('');
    console.log(
      '开始 rebuild comments...'
    );


    const rebuildResult =
      rebuildComments({
        monitorId
      });


    console.log(
      `rebuild 完成：新增 ${rebuildResult.insertedCount} 条，已存在跳过 ${rebuildResult.skippedCount} 条`
    );


    /**
     * ======================================
     * STEP 3：重新统计
     * ======================================
     */

    const emojis =
      JSON.parse(
        monitor.emojis ||
        '[]'
      );


    const texts =
      JSON.parse(
        monitor.texts ||
        '[]'
      );


    const allComments =
      getAllComments(
        monitorId
      );


    const stats =
      analyzeComments(
        allComments.map(
          comment => ({
            content:
              comment.content
          })
        ),

        emojis,
        texts
      );


    saveDailyStats({
      monitorId,

      statDate:
        todayString(),

      ...stats
    });


    updateMonitorStatus(
      monitorId,
      'success'
    );


    console.log('');
    console.log(
      '========== Monitor 完成 =========='
    );

    console.log(
      `数据库评论总数：${stats.totalComments}`
    );

    console.log(
      `本次新增：${rebuildResult.insertedCount}`
    );


    return stats;


  } catch (error) {

    console.error('');
    console.error(
      `Monitor ${monitorId} 执行失败：`,
      error
    );


    updateMonitorStatus(
      monitorId,
      'error'
    );


    throw error;


  } finally {

    runningMonitors.delete(
      monitorId
    );
  }
}


/**
 * ==========================================
 * 全部 Monitor
 * ==========================================
 */

async function runAllMonitors() {

  const monitors =
    getMonitors(true);


  console.log(
    `当前共有 ${monitors.length} 个启用监控`
  );


  for (
    const monitor
    of monitors
  ) {

    try {

      await runMonitor(
        monitor.id
      );


    } catch (error) {

      console.error(
        `Monitor ${monitor.id} failed：${error.message}`
      );
    }
  }
}


/**
 * ==========================================
 * 每天 06:00
 * ==========================================
 */

function getNextSixAM() {

  const now =
    new Date();


  const next =
    new Date(now);


  next.setHours(
    6,
    0,
    0,
    0
  );


  if (
    next <= now
  ) {

    next.setDate(
      next.getDate() + 1
    );
  }


  return next;
}


function startScheduler() {

  const schedule =
    () => {

      const next =
        getNextSixAM();


      const delay =
        next.getTime() -
        Date.now();


      console.log(
        `下一次自动抓取：${next.toLocaleString()}`
      );


      setTimeout(

        async () => {

          try {

            await runAllMonitors();

          } finally {

            schedule();
          }
        },

        delay
      );
    };


  schedule();
}


module.exports = {
  runMonitor,
  runAllMonitors,
  startScheduler,

  buildPageUrl,
  getResumeState,
  fetchCommentPage,
  fetchAllResponses
};