const {
  db,
  initDatabase
} = require('./db');


/**
 * 从 response 中找到 comments。
 *
 * 当前微博接口：
 *
 * data.result
 */
function extractComments(data) {

  if (
    data?.data &&
    Array.isArray(data.data.result)
  ) {

    return data.data.result;
  }


  if (
    Array.isArray(data?.result)
  ) {

    return data.result;
  }


  return [];
}


/**
 * comment time 转换
 */
function normalizeCommentTime(value) {

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
    /^\d+$/.test(String(value))
  ) {

    const number =
      Number(value);


    /**
     * 13位毫秒
     */
    if (
      number >
      100000000000
    ) {

      return String(number);
    }


    /**
     * 10位秒
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
 * 判断 response 是不是成功的微博 response。
 *
 * 只处理：
 *
 * code === 100000
 */
function isSuccessfulResponse(data) {

  return (
    data &&
    typeof data === 'object' &&
    Number(data.code) === 100000
  );
}


/**
 * rebuild comments
 *
 *
 * options:
 *
 * {
 *   monitorId: 1
 * }
 *
 *
 * monitorId 不传：
 * 处理所有 monitor
 *
 * monitorId 传：
 * 只处理指定 monitor
 */
function rebuildComments(options = {}) {

  initDatabase();


  const monitorId =
    options.monitorId ??
    null;


  console.log('');
  console.log('================================');
  console.log('开始 rebuild comments');
  console.log('唯一判断条件：comment_id');
  console.log('存在 => 跳过');
  console.log('不存在 => INSERT');
  console.log('不会删除现有 comments');
  console.log('================================');


  let sql = `
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
  `;


  const params = [];


  if (monitorId !== null) {

    sql += `
      AND monitor_id = ?
    `;

    params.push(
      monitorId
    );
  }


  sql += `
    ORDER BY id ASC
  `;


  const responses =
    db.prepare(sql).all(
      ...params
    );


  /**
   * ★★★
   *
   * 只按照 comment_id 判断存在。
   *
   * 不使用 monitor_id。
   *
   * 不使用 uid。
   *
   * 不使用 content。
   *
   * 不使用 nickname。
   *
   * ★★★
   */
  const existsStatement =
    db.prepare(`
      SELECT 1
      FROM comments
      WHERE comment_id = ?
      LIMIT 1
    `);


  /**
   * 不用 saveComments。
   *
   * 因为 saveComments 当前数据库逻辑是：
   *
   * UNIQUE(monitor_id, comment_id)
   *
   * 而我们这里明确按照：
   *
   * comment_id
   *
   * 判断。
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
   * SQLite Transaction
   */
  db.exec('BEGIN');


  try {


    for (
      const response
      of responses
    ) {


      responseCount++;


      let data;


      /**
       * JSON parse
       */
      try {

        data =
          JSON.parse(
            response.response_json
          );


      } catch (error) {


        parseErrorCount++;


        console.error(
          `[response ${response.id}] JSON解析失败：${error.message}`
        );


        continue;
      }


      /**
       * ★忽略错误 response
       *
       * 例如：
       *
       * code != 100000
       */
      if (
        !isSuccessfulResponse(
          data
        )
      ) {

        ignoredResponseCount++;


        console.log(
          `[response ${response.id}] ` +
          `page=${response.page_num} ` +
          `code=${data?.code} ` +
          `不是成功 response，跳过`
        );


        continue;
      }


      successResponseCount++;


      const comments =
        extractComments(data);


      console.log(
        `[response ${response.id}] ` +
        `monitor=${response.monitor_id} ` +
        `page=${response.page_num} ` +
        `result=${comments.length}`
      );


      for (
        const comment
        of comments
      ) {


        parsedCommentCount++;


        /**
         * 微博 API 当前字段：
         *
         * id
         *
         * 兼容其他可能名字。
         */
        const rawCommentId =
          comment.comment_id ??
          comment.commentId ??
          comment.id ??
          comment.cid;


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
         *
         * ★ 唯一判断条件
         *
         * comment_id
         *
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


        const content =
          comment.content ??
          comment.text ??
          comment.comment ??
          comment.comment_content ??
          '';


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


        try {


          insertStatement.run(
            response.monitor_id,
            commentId,
            String(content),
            commentTime
          );


          insertedCount++;


        } catch (error) {


          insertErrorCount++;


          console.error(
            `[comment_id=${commentId}] 插入失败：${error.message}`
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


  const total =
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM comments
    `).get();


  console.log('');
  console.log('================================');
  console.log('rebuild comments 完成');
  console.log('================================');

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

  console.log('--------------------------------');

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

  console.log('--------------------------------');

  console.log(
    `comments当前总数     : ${total.count}`
  );

  console.log('================================');


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
      Number(total.count)
  };
}


/**
 * =====================================
 *
 * 如果直接：
 *
 * node src/rebuild-comments.js
 *
 * 则处理所有 response
 *
 * =====================================
 */
if (require.main === module) {

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


module.exports = {
  rebuildComments,
  extractComments
};