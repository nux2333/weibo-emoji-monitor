const {
  db,
  initDatabase
} = require('./db');


/**
 * ==========================================
 * 从微博 Response 中取得评论数组
 * ==========================================
 *
 * 当前接口：
 *
 * {
 *   code: 100000,
 *   data: {
 *     result: [...]
 *   }
 * }
 *
 * 同时兼容：
 *
 * {
 *   result: [...]
 * }
 */
function extractComments(data) {

  if (
    data?.data &&
    Array.isArray(
      data.data.result
    )
  ) {

    return data.data.result;
  }


  if (
    Array.isArray(
      data?.result
    )
  ) {

    return data.result;
  }


  return [];
}


/**
 * ==========================================
 * comment time 标准化
 * ==========================================
 */
function normalizeCommentTime(
  value
) {

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


    /**
     * 13 位毫秒时间戳
     */
    if (
      number >
      100000000000
    ) {

      return String(
        number
      );
    }


    /**
     * 10 位秒时间戳
     *
     * 转成毫秒
     */
    if (
      number >
      1000000000
    ) {

      return String(
        number * 1000
      );
    }
  }


  return String(value);
}


/**
 * ==========================================
 * 判断是不是成功微博 Response
 * ==========================================
 *
 * ★唯一成功条件：
 *
 * code === 100000
 */
function isSuccessfulResponse(
  data
) {

  return (
    data &&
    typeof data === 'object' &&
    Number(
      data.code
    ) === 100000
  );
}


/**
 * error_message 是否有内容
 */
function hasErrorMessage(
  response
) {

  return (
    response?.error_message !== null &&
    response?.error_message !== undefined &&
    String(
      response.error_message
    ).trim() !== ''
  );
}


/**
 * ==========================================
 * 读取需要处理的 API Responses
 * ==========================================
 *
 * 支持：
 *
 * rebuildComments()
 *
 * => 全部 Response
 *
 *
 * rebuildComments({
 *   monitorId: 1
 * })
 *
 * => 指定 Monitor 所有 Response
 *
 *
 * rebuildComments({
 *   responseId: 123
 * })
 *
 * => 只处理单条 Response
 */
function getResponses(
  options
) {

  const responseId =
    options.responseId ??
    null;

  const monitorId =
    options.monitorId ??
    null;


  /**
   * responseId 优先级最高。
   */
  if (
    responseId !== null
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
      WHERE id = ?
        AND response_json IS NOT NULL
        AND TRIM(response_json) <> ''
      LIMIT 1
    `).all(
      Number(
        responseId
      )
    );
  }


  /**
   * 指定 Monitor。
   */
  if (
    monitorId !== null
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
        AND response_json IS NOT NULL
        AND TRIM(response_json) <> ''
      ORDER BY id ASC
    `).all(
      Number(
        monitorId
      )
    );
  }


  /**
   * 全部 Response。
   */
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
    WHERE response_json IS NOT NULL
      AND TRIM(response_json) <> ''
    ORDER BY id ASC
  `).all();
}


/**
 * ==========================================
 * rebuild comments
 * ==========================================
 *
 * ★核心规则：
 *
 * comments 是否存在
 *
 * 只根据：
 *
 * comment_id
 *
 * 全局判断。
 *
 *
 * 不根据：
 *
 * monitor_id
 * uid
 * content
 * nickname
 *
 *
 * comment_id 已存在：
 *
 * SKIP
 *
 *
 * comment_id 不存在：
 *
 * INSERT
 *
 *
 * 不 UPDATE
 * 不 DELETE
 * 不清空 comments
 */
function rebuildComments(
  options = {}
) {

  initDatabase();


  const responseId =
    options.responseId ??
    null;

  const monitorId =
    options.monitorId ??
    null;


  console.log('');
  console.log(
    '================================'
  );

  console.log(
    '开始 rebuild comments'
  );


  if (
    responseId !== null
  ) {

    console.log(
      `处理单条 response：${responseId}`
    );

  } else if (
    monitorId !== null
  ) {

    console.log(
      `处理 monitor：${monitorId}`
    );

  } else {

    console.log(
      '处理全部 response'
    );
  }


  console.log(
    '唯一判断条件：comment_id'
  );

  console.log(
    '存在 => 跳过'
  );

  console.log(
    '不存在 => INSERT'
  );

  console.log(
    '不会更新现有 comments'
  );

  console.log(
    '不会删除现有 comments'
  );

  console.log(
    '================================'
  );


  const responses =
    getResponses(
      options
    );


  /**
   * ==========================================
   * ★全局 comment_id 判断
   * ==========================================
   */
  const existsStatement =
    db.prepare(`
      SELECT 1
      FROM comments
      WHERE comment_id = ?
      LIMIT 1
    `);


  /**
   * ==========================================
   * INSERT
   * ==========================================
   *
   * 不调用 db.js 的 saveComments。
   *
   * 因为 saveComments 的数据库冲突规则是：
   *
   * UNIQUE(monitor_id, comment_id)
   *
   * 但这里我们的业务规则明确是：
   *
   * comment_id 全局唯一判断。
   */
  const insertStatement =
    db.prepare(`
      INSERT INTO comments (
        monitor_id,
        comment_id,
        content,
        comment_time
      )
      VALUES (?, ?, ?, ?)
    `);


  let responseCount = 0;

  let successResponseCount = 0;

  let ignoredResponseCount = 0;

  let parsedCommentCount = 0;

  let insertedCount = 0;

  let skippedCount = 0;

  let invalidCommentCount = 0;

  let parseErrorCount = 0;

  let insertErrorCount = 0;


  /**
   * ==========================================
   * Transaction
   * ==========================================
   *
   * Node 原生 DatabaseSync，
   * 所以直接：
   *
   * BEGIN
   * COMMIT
   * ROLLBACK
 */
  db.exec(
    'BEGIN'
  );


  try {

    for (
      const response
      of responses
    ) {

      responseCount++;


      /**
       * ======================================
       * ★第一层：
       *
       * error_message 有值
       *
       * 一定跳过。
       * ======================================
       */
      if (
        hasErrorMessage(
          response
        )
      ) {

        ignoredResponseCount++;


        console.log(
          `[response ${response.id}] ` +
          `monitor=${response.monitor_id} ` +
          `page=${response.page_num} ` +
          'error_message 有值，跳过'
        );


        continue;
      }


      let data;


      /**
       * ======================================
       * JSON parse
       * ======================================
       */
      try {

        data =
          JSON.parse(
            response.response_json
          );


      } catch (error) {

        parseErrorCount++;


        console.error(
          `[response ${response.id}] ` +
          `JSON解析失败：${error.message}`
        );


        continue;
      }


      /**
       * ======================================
       * ★第二层：
       *
       * code != 100000
       *
       * 也跳过。
       *
       * 这样兼容历史数据：
       *
       * 有些旧 response
       * error_message 可能还是空，
       * 但是 code 实际已经失败。
       * ======================================
       */
      if (
        !isSuccessfulResponse(
          data
        )
      ) {

        ignoredResponseCount++;


        console.log(
          `[response ${response.id}] ` +
          `monitor=${response.monitor_id} ` +
          `page=${response.page_num} ` +
          `code=${data?.code} ` +
          '不是成功 response，跳过'
        );


        continue;
      }


      successResponseCount++;


      /**
       * ======================================
       * 提取评论
       * ======================================
       */
      const comments =
        extractComments(
          data
        );


      console.log(
        `[response ${response.id}] ` +
        `monitor=${response.monitor_id} ` +
        `page=${response.page_num} ` +
        `result=${comments.length}`
      );


      /**
       * ======================================
       * 遍历评论
       * ======================================
       */
      for (
        const comment
        of comments
      ) {

        parsedCommentCount++;


        /**
         * 当前微博字段：
         *
         * id
         *
         * 同时兼容其他名字。
         */
        const rawCommentId =
          comment.comment_id ??
          comment.commentId ??
          comment.id ??
          comment.cid;


        /**
         * 没有 comment_id：
         *
         * 无法去重，
         * 所以直接跳过。
         */
        if (
          rawCommentId === null ||
          rawCommentId === undefined ||
          rawCommentId === ''
        ) {

          invalidCommentCount++;


          console.warn(
            `[response ${response.id}] ` +
            '发现没有 comment_id 的评论，跳过'
          );


          continue;
        }


        const commentId =
          String(
            rawCommentId
          );


        /**
         * ==================================
         * ★★★
         *
         * 唯一判断条件：
         *
         * comment_id
         *
         * 全局查 comments。
         *
         * 不带 monitor_id。
         *
         * ★★★
         * ==================================
         */
        const exists =
          existsStatement.get(
            commentId
          );


        if (exists) {

          skippedCount++;

          continue;
        }


        /**
         * 评论内容。
         */
        const content =
          comment.content ??
          comment.text ??
          comment.comment ??
          comment.comment_content ??
          '';


        /**
         * 评论时间。
         */
        const rawCommentTime =
          comment.created_at ??
          comment.create_time ??
          comment.createdAt ??
          comment.comment_time ??
          comment.commentTime ??
          comment.time ??
          null;


        const commentTime =
          normalizeCommentTime(
            rawCommentTime
          );


        /**
         * ==================================
         * INSERT
         * ==================================
         */
        try {

          insertStatement.run(
            response.monitor_id,
            commentId,
            String(
              content
            ),
            commentTime
          );


          insertedCount++;


        } catch (error) {

          insertErrorCount++;


          console.error(
            `[response ${response.id}] ` +
            `[comment_id=${commentId}] ` +
            `插入失败：${error.message}`
          );
        }
      }
    }


    db.exec(
      'COMMIT'
    );


  } catch (error) {

    db.exec(
      'ROLLBACK'
    );


    throw error;
  }


  /**
   * ==========================================
   * 当前 comments 总数
   * ==========================================
   */
  const total =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM comments
    `).get();


  console.log('');
  console.log(
    '================================'
  );

  console.log(
    'rebuild comments 完成'
  );

  console.log(
    '================================'
  );


  console.log(
    `读取 response        : ${responseCount}`
  );

  console.log(
    `成功 response        : ${successResponseCount}`
  );

  console.log(
    `错误 response 跳过   : ${ignoredResponseCount}`
  );

  console.log(
    `JSON解析失败         : ${parseErrorCount}`
  );


  console.log(
    '--------------------------------'
  );


  console.log(
    `解析评论             : ${parsedCommentCount}`
  );

  console.log(
    `新增                 : ${insertedCount}`
  );

  console.log(
    `comment_id存在跳过   : ${skippedCount}`
  );

  console.log(
    `无效评论             : ${invalidCommentCount}`
  );

  console.log(
    `INSERT失败           : ${insertErrorCount}`
  );


  console.log(
    '--------------------------------'
  );


  console.log(
    `comments当前总数     : ${total.count}`
  );


  console.log(
    '================================'
  );


  return {
    responseCount,
    successResponseCount,
    ignoredResponseCount,
    parseErrorCount,
    parsedCommentCount,
    insertedCount,
    skippedCount,
    invalidCommentCount,
    insertErrorCount,

    totalComments:
      Number(
        total.count
      )
  };
}


/**
 * ==========================================
 * 手动命令
 * ==========================================
 *
 * npm run rebuild-comments
 *
 * 或：
 *
 * node src/rebuild-comments.js
 *
 *
 * 不带参数：
 *
 * 处理全部历史 response。
 */
if (
  require.main === module
) {

  try {

    rebuildComments();


  } catch (error) {

    console.error('');
    console.error(
      'rebuild-comments 执行失败：'
    );

    console.error(
      error
    );


    process.exitCode = 1;
  }
}


/**
 * ==========================================
 * exports
 * ==========================================
 */
module.exports = {
  rebuildComments,
  extractComments,
  normalizeCommentTime,
  isSuccessfulResponse
};