const { chromium } = require('playwright');

const {
  db,
  getMonitor,
  getMonitors,
  saveComments,
  saveDailyStats,
  updateMonitorStatus,
  getAllComments
} = require('./db');

const {
  analyzeComments
} = require('./emoji');


/**
 * ============================================================
 * 基本配置
 * ============================================================
 */

/**
 * 每页请求多少条
 */
const DEFAULT_PAGE_SIZE = 100;

/**
 * 页面之间等待
 */
const PAGE_DELAY = 500;

/**
 * 请求失败后等待 3 分钟
 */
const ERROR_RETRY_DELAY = 3 * 60 * 1000;

/**
 * 单个 API 请求最多等待 60 秒
 */
const API_TIMEOUT = 60 * 1000;


/**
 * ============================================================
 * 正在运行的 Monitor
 * ============================================================
 */

const runningMonitors = new Set();


/**
 * ============================================================
 * API Response 数据表
 * ============================================================
 *
 * 不需要手动修改 db.js。
 *
 * monitor.js 启动抓取时会自动创建。
 */

function initApiResponseTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_responses (

      id INTEGER PRIMARY KEY AUTOINCREMENT,

      monitor_id INTEGER NOT NULL,

      page_num INTEGER NOT NULL,

      api_url TEXT NOT NULL,

      http_status INTEGER,

      response_json TEXT,

      error_message TEXT,

      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (
        monitor_id
      )
      REFERENCES monitors(id)
      ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_api_responses_monitor
    ON api_responses(monitor_id);

    CREATE INDEX IF NOT EXISTS idx_api_responses_page
    ON api_responses(monitor_id, page_num);
  `);
}


/**
 * ============================================================
 * 保存 API Response
 * ============================================================
 *
 * 无论成功还是失败，都尽量保存一条记录。
 */

function saveApiResponse({
  monitorId,
  pageNum,
  apiUrl,
  httpStatus = null,
  responseData = null,
  errorMessage = null
}) {
  try {

    initApiResponseTable();

    let responseJson = null;

    if (
      responseData !== null &&
      responseData !== undefined
    ) {

      try {

        responseJson =
          JSON.stringify(
            responseData
          );

      } catch (error) {

        responseJson =
          String(
            responseData
          );
      }
    }

    db.prepare(`
      INSERT INTO api_responses (
        monitor_id,
        page_num,
        api_url,
        http_status,
        response_json,
        error_message
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      monitorId,
      pageNum,
      apiUrl,
      httpStatus,
      responseJson,
      errorMessage
    );

    console.log(
      `API Response 已保存：第 ${pageNum} 页`
    );

  } catch (error) {

    /**
     * 注意：
     *
     * 这里不能继续 throw。
     *
     * 否则可能因为保存 response 本身失败，
     * 把真正的 API 错误覆盖掉。
     */

    console.error(
      `保存 API Response 失败：${error.message}`
    );
  }
}


/**
 * ============================================================
 * 今天日期
 * ============================================================
 */

function todayString() {

  const now =
    new Date();

  const year =
    now.getFullYear();

  const month =
    String(
      now.getMonth() + 1
    ).padStart(2, '0');

  const day =
    String(
      now.getDate()
    ).padStart(2, '0');

  return `${year}-${month}-${day}`;
}


/**
 * ============================================================
 * 评论时间解析
 * ============================================================
 */

function parseCommentTime(value) {

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  /**
   * 数字时间戳
   */
  if (
    typeof value === 'number' ||
    /^\d+$/.test(
      String(value)
    )
  ) {

    const number =
      Number(value);

    if (
      number > 100000000000
    ) {
      return number;
    }

    if (
      number > 1000000000
    ) {
      return number * 1000;
    }
  }

  const text =
    String(value).trim();

  /**
   * ISO / 普通时间格式
   */
  let timestamp =
    Date.parse(text);

  if (
    !Number.isNaN(timestamp)
  ) {
    return timestamp;
  }

  /**
   * YYYY-MM-DD HH:mm:ss
   */
  timestamp =
    Date.parse(
      text.replace(
        /-/g,
        '/'
      )
    );

  if (
    !Number.isNaN(timestamp)
  ) {
    return timestamp;
  }

  return null;
}


/**
 * ============================================================
 * 从 API JSON 中寻找评论数组
 * ============================================================
 */

function findCommentArrays(
  value,
  result = [],
  depth = 0
) {

  if (
    value === null ||
    value === undefined
  ) {
    return result;
  }

  if (
    depth > 20
  ) {
    return result;
  }

  if (
    Array.isArray(value)
  ) {

    const possibleComments =
      value.filter(
        item =>
          item &&
          typeof item === 'object' &&
          (
            item.content ||
            item.text ||
            item.comment ||
            item.comment_content
          ) &&
          (
            item.id !== undefined ||
            item.comment_id !== undefined ||
            item.commentId !== undefined ||
            item.cid !== undefined
          )
      );

    if (
      possibleComments.length > 0
    ) {

      result.push(
        possibleComments
      );
    }

    for (
      const item of value
    ) {

      findCommentArrays(
        item,
        result,
        depth + 1
      );
    }

    return result;
  }

  if (
    typeof value === 'object'
  ) {

    for (
      const key of Object.keys(value)
    ) {

      findCommentArrays(
        value[key],
        result,
        depth + 1
      );
    }
  }

  return result;
}


/**
 * ============================================================
 * 标准化评论
 * ============================================================
 */

function normalizeComments(
  data
) {

  const arrays =
    findCommentArrays(data);

  const map =
    new Map();

  for (
    const commentArray of arrays
  ) {

    for (
      const item of commentArray
    ) {

      const commentId =
        item.comment_id ??
        item.commentId ??
        item.id ??
        item.cid;

      const content =
        item.content ??
        item.text ??
        item.comment ??
        item.comment_content;

      if (
        commentId === undefined ||
        commentId === null ||
        !content
      ) {
        continue;
      }

      const id =
        String(
          commentId
        );

      if (
        !map.has(id)
      ) {

        map.set(
          id,
          {
            commentId: id,

            content:
              String(content),

            commentTime:
              item.created_at ??
              item.create_time ??
              item.createdAt ??
              item.comment_time ??
              item.commentTime ??
              item.time ??
              null
          }
        );
      }
    }
  }

  return Array.from(
    map.values()
  );
}


/**
 * ============================================================
 * 修改分页 URL
 * ============================================================
 */

function buildPageUrl(
  originalUrl,
  pageNum,
  pageSize
) {

  const url =
    new URL(
      originalUrl
    );

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
 * ============================================================
 * API 下一页状态
 * ============================================================
 */

function getApiNextState(
  data
) {

  if (
    data &&
    data.data &&
    typeof data.data.is_next !== 'undefined'
  ) {

    return (
      Number(
        data.data.is_next
      ) === 1
    );
  }

  if (
    data &&
    typeof data.is_next !== 'undefined'
  ) {

    return (
      Number(
        data.is_next
      ) === 1
    );
  }

  /**
   * 没有 is_next：
   *
   * 不人为限制页数。
   *
   * 当前页有数据 → 继续。
   *
   * 当前页 0 条 → 外层停止。
   */

  return null;
}


/**
 * ============================================================
 * 请求一页 API
 * ============================================================
 *
 * 这里是这次最重要的修改。
 *
 * fetch 本身增加 AbortController。
 *
 * 如果 60 秒没有返回：
 *
 * 1. page.evaluate 返回 timeout
 * 2. monitor.js 保存失败记录
 * 3. 外层等待 3 分钟
 * 4. 重新请求同一个 page
 *
 * 所以不会出现“失败了但是没有 response 记录”的情况。
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

  console.log(
    `请求第 ${pageNum} 页：${apiUrl}`
  );


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
              () => {
                controller.abort();
              },
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

            let data = null;

            try {

              data =
                JSON.parse(
                  text
                );

            } catch (error) {

              return {
                ok: false,

                type:
                  'invalid_json',

                status:
                  response.status,

                responseText:
                  text,

                error:
                  `API 返回的不是 JSON：${text.slice(0, 1000)}`
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
                error.name === 'AbortError'
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

            clearTimeout(
              timer
            );
          }

        },
        {
          url:
            apiUrl,

          timeout:
            API_TIMEOUT
        }
      );


    /**
     * ========================================================
     * API 正常返回
     * ========================================================
     */

    if (
      result.ok
    ) {

      /**
       * HTTP 非 2xx
       *
       * 也保存完整 response。
       */

      if (
        result.status < 200 ||
        result.status >= 300
      ) {

        saveApiResponse({
          monitorId,
          pageNum,
          apiUrl,
          httpStatus:
            result.status,
          responseData:
            result.data,
          errorMessage:
            `HTTP 状态异常：${result.status}`
        });

        throw new Error(
          `API HTTP 状态异常：${result.status}`
        );
      }


      /**
       * ======================================================
       * 成功 response
       * 立即保存完整 JSON
       * ======================================================
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


      return result.data;
    }


    /**
     * ========================================================
     * API 请求失败
     * ========================================================
     *
     * 即使没有 HTTP response，
     * 也必须写入 api_responses。
     */

    let errorMessage =
      result.error ||
      '未知 API 错误';


    if (
      result.type === 'timeout'
    ) {

      errorMessage =
        `API 请求超时（${API_TIMEOUT / 1000} 秒）`;

    } else if (
      result.type === 'network'
    ) {

      errorMessage =
        `网络请求失败：${errorMessage}`;

    } else if (
      result.type === 'invalid_json'
    ) {

      errorMessage =
        result.error;
    }


    /**
     * 如果 API 返回了文本但 JSON 解析失败，
     * 把原始 response 文本也存进去。
     */

    let responseData =
      null;

    if (
      result.responseText !== null &&
      result.responseText !== undefined
    ) {

      responseData = {
        raw_response:
          result.responseText
      };
    }


    /**
     * 关键：
     *
     * 失败 response 也保存。
     */

    saveApiResponse({
      monitorId,
      pageNum,
      apiUrl,
      httpStatus:
        result.status,
      responseData,
      errorMessage
    });


    throw new Error(
      errorMessage
    );

  } catch (error) {

    /**
     * ========================================================
     * Playwright 本身异常
     * ========================================================
     *
     * 例如：
     *
     * page crashed
     * browser disconnected
     * evaluate failed
     * context destroyed
     *
     * 这些也必须保存。
     *
     * 但如果上面已经保存过，
     * 这里不要重复保存同一个错误。
     */

    const message =
      error.message ||
      String(error);


    /**
     * 只有这里真正捕获到的异常
     * 才额外写一次。
     *
     * 正常的 API 错误已经在上面保存过。
     */

    if (
      !message.startsWith(
        'API 请求超时'
      ) &&
      !message.startsWith(
        '网络请求失败：'
      ) &&
      !message.startsWith(
        'API HTTP 状态异常：'
      ) &&
      !message.startsWith(
        'API 返回的不是 JSON：'
      )
    ) {

      saveApiResponse({
        monitorId,
        pageNum,
        apiUrl,
        httpStatus:
          null,
        responseData:
          null,
        errorMessage:
          `Playwright/API 异常：${message}`
      });
    }


    throw error;
  }
}


/**
 * ============================================================
 * 获取 DB 最新评论时间
 * ============================================================
 *
 * 注意：
 *
 * 这个时间只在一次 Monitor 开始的时候获取一次。
 *
 * 后面不会因为 saveComments()
 * 而重新改变 cutoff。
 */

function getLatestCommentTime(
  monitorId
) {

  const comments =
    getAllComments(
      monitorId
    );

  let latest =
    null;

  for (
    const comment of comments
  ) {

    const timestamp =
      parseCommentTime(
        comment.comment_time
      );

    if (
      timestamp === null
    ) {
      continue;
    }

    if (
      latest === null ||
      timestamp > latest
    ) {

      latest =
        timestamp;
    }
  }

  return latest;
}


/**
 * ============================================================
 * 判断当前页是不是历史数据
 * ============================================================
 *
 * cutoffTime 是本次抓取开始前 DB 的最新时间。
 *
 * 当前页所有有时间的评论
 * 都 <= cutoffTime
 *
 * 才认为已经进入历史区域。
 */

function pageIsHistory(
  comments,
  cutoffTime
) {

  if (
    cutoffTime === null
  ) {
    return false;
  }


  const commentsWithTime =
    comments.filter(
      comment =>
        parseCommentTime(
          comment.commentTime
        ) !== null
    );


  /**
   * 没有任何时间：
   *
   * 不敢判断。
   */

  if (
    commentsWithTime.length === 0
  ) {

    return false;
  }


  for (
    const comment of commentsWithTime
  ) {

    const time =
      parseCommentTime(
        comment.commentTime
      );

    /**
     * 发现比 DB cutoff 新的评论
     *
     * 说明当前页仍然属于新数据区域。
     */

    if (
      time > cutoffTime
    ) {

      return false;
    }
  }


  /**
   * 当前页全部 <= cutoff
   */

  return true;
}


/**
 * ============================================================
 * 过滤本页真正需要保存的评论
 * ============================================================
 */

function filterNewComments(
  comments,
  cutoffTime,
  incremental
) {

  /**
   * 首次全量：
   *
   * 全部保存。
   */

  if (
    !incremental ||
    cutoffTime === null
  ) {

    return comments;
  }


  const result = [];


  for (
    const comment of comments
  ) {

    const time =
      parseCommentTime(
        comment.commentTime
      );


    /**
     * 没有评论时间：
     *
     * 为避免漏数据，
     * 暂时保存。
     */

    if (
      time === null
    ) {

      result.push(
        comment
      );

      continue;
    }


    /**
     * 只有比本次开始时 DB 最新时间
     * 更新的评论才保存。
     */

    if (
      time > cutoffTime
    ) {

      result.push(
        comment
      );
    }
  }


  return result;
}


/**
 * ============================================================
 * 抓取评论
 * ============================================================
 */

async function fetchComments(
  url,
  monitorId,
  incremental = true
) {

  const browser =
    await chromium.launch({
      headless: true
    });


  const page =
    await browser.newPage({

      viewport: {
        width: 390,
        height: 844
      },

      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 ' +
        'Mobile/15E148 Safari/604.1'
    });


  /**
   * ========================================================
   * 本次抓取开始时的 DB cutoff
   * ========================================================
   *
   * 非常重要：
   *
   * 后面无论保存多少评论，
   * cutoff 都不会改变。
   */

  const cutoffTime =
    incremental
      ? getLatestCommentTime(
          monitorId
        )
      : null;


  console.log(
    `DB 抓取开始时最新评论时间：${
      cutoffTime
        ? new Date(
            cutoffTime
          ).toLocaleString()
        : '无'
    }`
  );


  let pageNum = 1;


  /**
   * 本次运行发现的评论
   */
  const allComments =
    new Map();


  /**
   * 本次运行实际新增
   */
  const newComments =
    new Map();


  try {

    console.log('');
    console.log(
      '================================'
    );

    console.log(
      `开始抓取：${url}`
    );

    console.log(
      incremental
        ? '当前模式：按评论时间增量抓取'
        : '当前模式：首次全量抓取'
    );

    console.log(
      '================================'
    );


    /**
     * ========================================================
     * 首先打开原始 URL
     * ========================================================
     */

    await page.goto(
      url,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60 * 1000
      }
    );


    await page.waitForTimeout(
      2000
    );


    /**
     * ========================================================
     * 无限分页
     * ========================================================
     */

    while (true) {

      let data;


      /**
       * ======================================================
       * 当前页请求
       *
       * 失败：
       *
       * 休息 3 分钟
       * 再重新请求当前 pageNum。
       * ======================================================
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

            break;

        } catch (error) {

          console.error('');
          console.error(
            `第 ${pageNum} 页请求失败：${error.message}`
          );

          console.error(
            '================================'
          );

          console.error(
            `失败 URL：${buildPageUrl(
              url,
              pageNum,
              DEFAULT_PAGE_SIZE
            )}`
          );

          console.error(
            '失败记录已经保存到 api_responses'
          );

          console.error(
            '3 分钟后重新请求当前页面...'
          );

          console.error(
            '================================'
          );


          /**
           * 等 3 分钟
           */

          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                ERROR_RETRY_DELAY
              )
          );


          /**
           * ==================================================
           * 重新建立微博 session
           * ==================================================
           */

          try {

            await page.goto(
              url,
              {
                waitUntil:
                  'domcontentloaded',

                timeout:
                  60 * 1000
              }
            );

            await page.waitForTimeout(
              2000
            );

          } catch (reloadError) {

            console.error(
              `重新打开页面失败：${reloadError.message}`
            );

            /**
             * 不退出。
             *
             * 下一轮继续尝试。
             */
          }
        }
      }


      /**
       * ========================================================
       * 解析 API response
       * ========================================================
       */

      const comments =
        normalizeComments(
          data
        );


      console.log(
        `第 ${pageNum} 页 API 返回：${comments.length} 条`
      );


      /**
       * ========================================================
       * 0 条
       *
       * 这是唯一明确的“没有数据”情况。
       * ========================================================
       */

      if (
        comments.length === 0
      ) {

        console.log(
          'API 返回 0 条评论，停止抓取。'
        );

        break;
      }


      /**
       * ========================================================
       * 判断是否已经进入历史
       *
       * 注意：
       *
       * 先判断 cutoff，
       * 然后才保存新评论。
       *
       * 不会因为刚刚 saveComments()
       * 改变 cutoff。
       * ========================================================
       */

      const historyPage =
        incremental &&
        pageIsHistory(
          comments,
          cutoffTime
        );


      if (
        historyPage
      ) {

        console.log(
          `第 ${pageNum} 页全部属于历史评论。`
        );

        console.log(
          '停止继续翻页。'
        );

        break;
      }


      /**
       * ========================================================
       * 当前页数据去重
       * ========================================================
       */

      const pageNewComments =
        [];


      for (
        const comment of comments
      ) {

        const id =
          String(
            comment.commentId
          );


        /**
         * 本次运行已经处理
         */

        if (
          allComments.has(id)
        ) {

          continue;
        }


        allComments.set(
          id,
          comment
        );


        /**
         * 根据 cutoff 判断是否新评论
         */

        const shouldSave =
          filterNewComments(
            [comment],
            cutoffTime,
            incremental
          ).length > 0;


        if (
          shouldSave
        ) {

          pageNewComments.push(
            comment
          );

          newComments.set(
            id,
            comment
          );
        }
      }


      /**
       * ========================================================
       * 关键：
       *
       * 每一页处理完马上保存。
       *
       * 不等全部分页结束。
       * ========================================================
       */

      if (
        pageNewComments.length > 0
      ) {

        console.log(
          `本页新评论：${pageNewComments.length} 条`
        );

        console.log(
          `立即保存本页评论...`
        );


        saveComments(
          monitorId,
          pageNewComments
        );


        console.log(
          `本页评论保存完成`
        );

      } else {

        console.log(
          '本页没有需要新增保存的评论'
        );
      }


      /**
       * ========================================================
       * 打印本页历史数量
       * ========================================================
       */

      const pageHistoryCount =
        comments.length -
        pageNewComments.length;


      console.log(
        `本页历史评论：${pageHistoryCount} 条`
      );


      /**
       * ========================================================
       * API 是否明确没有下一页
       * ========================================================
       */

      const nextState =
        getApiNextState(
          data
        );


      if (
        nextState === false
      ) {

        console.log(
          'API 表示已经没有下一页。'
        );

        break;
      }


      /**
       * ========================================================
       * 下一页
       * ========================================================
       */

      pageNum++;


      /**
       * 页面之间等待
       */

      if (
        PAGE_DELAY > 0
      ) {

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              PAGE_DELAY
            )
        );
      }
    }


    /**
     * ========================================================
     * 最终结果
     * ========================================================
     */

    const comments =
      Array.from(
        allComments.values()
      );


    const savedNewComments =
      Array.from(
        newComments.values()
      );


    console.log('');

    console.log(
      '========== 抓取完成 =========='
    );

    console.log(
      `本次发现评论：${comments.length} 条`
    );

    console.log(
      `本次新增评论：${savedNewComments.length} 条`
    );

    console.log(
      '所有页面数据已经按页保存'
    );

    console.log(
      '=============================='
    );


    return {

      allComments:
        comments,

      newComments:
        savedNewComments,

      isIncremental:
        incremental
    };


  } finally {

    await browser.close();
  }
}


/**
 * ============================================================
 * 执行单个 Monitor
 * ============================================================
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


  const monitor =
    getMonitor(
      monitorId
    );


  if (!monitor) {

    throw new Error(
      `Monitor ${monitorId} 不存在`
    );
  }


  if (
    !monitor.enabled
  ) {

    console.log(
      `Monitor ${monitorId} 已停用`
    );

    return;
  }


  runningMonitors.add(
    monitorId
  );


  try {

    /**
     * 确保 api_responses 表存在
     */

    initApiResponseTable();


    updateMonitorStatus(
      monitorId,
      'running'
    );


    const emojis =
      JSON.parse(
        monitor.emojis || '[]'
      );


    const texts =
      JSON.parse(
        monitor.texts || '[]'
      );


    /**
     * 判断是否第一次运行
     */

    const existingComments =
      getAllComments(
        monitorId
      );


    const firstRun =
      existingComments.length === 0;


    console.log('');

    console.log(
      `========== Monitor ${monitorId} ==========`
    );

    console.log(
      `名称：${monitor.name}`
    );

    console.log(
      `Emoji：${emojis.join(', ')}`
    );

    console.log(
      `文本：${texts.join(', ')}`
    );

    console.log(
      firstRun
        ? '首次抓取：全量'
        : '后续抓取：按评论时间增量'
    );


    /**
     * ========================================================
     * 抓取
     * ========================================================
     */

    const result =
      await fetchComments(
        monitor.url,
        monitorId,
        !firstRun
      );


    /**
     * ========================================================
     * DB 全部评论
     * ========================================================
     */

    const allDatabaseComments =
      getAllComments(
        monitorId
      );


    console.log(
      `数据库当前评论总数：${allDatabaseComments.length}`
    );


    /**
     * ========================================================
     * 统计
     * ========================================================
     */

    const stats =
      analyzeComments(
        allDatabaseComments.map(
          item => ({
            content:
              item.content
          })
        ),
        emojis,
        texts
      );


    /**
     * ========================================================
     * 保存每日统计
     * ========================================================
     */

    saveDailyStats({

      monitorId,

      statDate:
        todayString(),

      totalComments:
        stats.totalComments,

      matchedComments:
        stats.matchedComments,

      unmatchedComments:
        stats.unmatchedComments,

      emojiTotal:
        stats.emojiTotal,

      textTotal:
        stats.textTotal,

      emojiStats:
        stats.emojiStats,

      textStats:
        stats.textStats
    });


    updateMonitorStatus(
      monitorId,
      'success'
    );


    console.log('');

    console.log(
      '========== 最终统计 =========='
    );

    console.log(
      `数据库评论总数：${stats.totalComments}`
    );

    console.log(
      `本次抓取发现：${result.allComments.length}`
    );

    console.log(
      `本次新增：${result.newComments.length}`
    );

    console.log(
      `包含指定内容的评论：${stats.matchedComments}`
    );

    console.log(
      `不含指定内容的评论：${stats.unmatchedComments}`
    );

    console.log(
      `Emoji 合计：${stats.emojiTotal}`
    );

    console.log(
      `文本合计：${stats.textTotal}`
    );

    console.log(
      '=============================='
    );


    return stats;


  } catch (error) {

    console.error(
      `Monitor ${monitorId} 抓取失败：`,
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
 * ============================================================
 * 全部 Monitor
 * ============================================================
 */

async function runAllMonitors() {

  const monitors =
    getMonitors(true);


  console.log(
    `当前共有 ${monitors.length} 个启用监控`
  );


  for (
    const monitor of monitors
  ) {

    try {

      await runMonitor(
        monitor.id
      );

    } catch (error) {

      console.error(
        `Monitor ${monitor.id} failed:`,
        error.message
      );
    }
  }
}


/**
 * ============================================================
 * 下一次 06:00
 * ============================================================
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


/**
 * ============================================================
 * Scheduler
 * ============================================================
 */

function startScheduler() {

  const scheduleNext =
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

            console.log(
              '开始每日自动抓取'
            );


            await runAllMonitors();

          } catch (error) {

            console.error(
              '每日抓取失败：',
              error
            );

          } finally {

            scheduleNext();
          }

        },
        delay
      );
    };


  scheduleNext();
}


/**
 * ============================================================
 * 导出
 * ============================================================
 */

module.exports = {
  runMonitor,
  runAllMonitors,
  startScheduler
};

