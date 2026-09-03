const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'monitor.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('SQLite DB:', DB_FILE);

const db = new DatabaseSync(DB_FILE);


/**
 * ============================================================
 * 数据库初始化 / 旧数据库自动升级
 * ============================================================
 */

function tableHasColumn(tableName, columnName) {
	return db
		.prepare(`PRAGMA table_info(${tableName})`)
		.all()
		.some(row => row.name === columnName);
}


function ensureColumn(tableName, columnName, definition) {
	if (tableHasColumn(tableName, columnName)) {
		return;
	}

	db.exec(`
    ALTER TABLE ${tableName}
    ADD COLUMN ${columnName} ${definition}
  `);

	console.log(
		`数据库字段已补充：${tableName}.${columnName}`
	);
}


function initDatabase() {

	db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      name TEXT NOT NULL,
      url TEXT NOT NULL,

      emojis TEXT NOT NULL DEFAULT '[]',
      texts TEXT NOT NULL DEFAULT '[]',

      enabled INTEGER NOT NULL DEFAULT 1,

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      last_run_at TEXT,
      last_status TEXT
    );


    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      monitor_id INTEGER NOT NULL,
      comment_id TEXT NOT NULL,

      buyer_nickname TEXT,
      customerid TEXT,
      sku_name TEXT,

      content TEXT NOT NULL,
      comment_time TEXT,

      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(
        monitor_id,
        comment_id
      ),

      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS api_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      monitor_id INTEGER NOT NULL,

      page_num INTEGER NOT NULL,

      api_url TEXT NOT NULL,

      http_status INTEGER,

      response_json TEXT,

      error_message TEXT,

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
    );


    CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      monitor_id INTEGER NOT NULL,

      stat_date TEXT NOT NULL,

      total_comments INTEGER NOT NULL DEFAULT 0,

      emoji_total INTEGER NOT NULL DEFAULT 0,

      non_emoji_total INTEGER NOT NULL DEFAULT 0,

      emoji_stats TEXT NOT NULL DEFAULT '{}',

      text_stats TEXT NOT NULL DEFAULT '{}',

      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(
        monitor_id,
        stat_date
      ),

      FOREIGN KEY(monitor_id)
        REFERENCES monitors(id)
        ON DELETE CASCADE
    );
	
	
	  CREATE TABLE IF NOT EXISTS superlike_posts (
	    id INTEGER PRIMARY KEY AUTOINCREMENT,

	    post_id TEXT NOT NULL UNIQUE,

	    uid TEXT,
	    username TEXT,

	    post_link TEXT,
	    post_text TEXT,

	    comments_count INTEGER NOT NULL DEFAULT 0,

	    current_has_superlike INTEGER NOT NULL DEFAULT 0,

	    icon_summary TEXT,

	    experience_7d INTEGER,

	    post_created_at TEXT,

	    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

	    raw_json TEXT
	  );

	  CREATE INDEX IF NOT EXISTS
	    idx_superlike_posts_uid
	    ON superlike_posts(uid);

	  CREATE INDEX IF NOT EXISTS
	    idx_superlike_posts_comments
	    ON superlike_posts(comments_count);

	  CREATE INDEX IF NOT EXISTS
	    idx_superlike_posts_superlike
	    ON superlike_posts(current_has_superlike);

	  CREATE INDEX IF NOT EXISTS
	    idx_superlike_posts_last_seen
	    ON superlike_posts(last_seen_at);
	
  `);


	/*
	 * ==========================================================
	 * 兼容你的旧 monitor.db
	 *
	 * 不删除任何旧数据。
	 * 缺哪个字段就自动 ALTER TABLE 补哪个字段。
	 * ==========================================================
	 */

	ensureColumn(
		'comments',
		'buyer_nickname',
		'TEXT'
	);

	ensureColumn(
		'comments',
		'customerid',
		'TEXT'
	);

	ensureColumn(
		'comments',
		'sku_name',
		'TEXT'
	);


	/*
	 * Latest / History 拆分后的新字段
	 */

	ensureColumn(
		'monitors',
		'history_next_page',
		'INTEGER'
	);

	ensureColumn(
		'monitors',
		'history_completed',
		'INTEGER NOT NULL DEFAULT 0'
	);

	ensureColumn(
		'monitors',
		'latest_last_run_at',
		'TEXT'
	);

	ensureColumn(
		'monitors',
		'latest_last_status',
		'TEXT'
	);

	ensureColumn(
		'monitors',
		'history_last_run_at',
		'TEXT'
	);

	ensureColumn(
		'monitors',
		'history_last_status',
		'TEXT'
	);


	/*
	 * 用来区分：
	 *
	 * latest
	 * history
	 * legacy
	 */

	ensureColumn(
		'api_responses',
		'crawl_type',
		"TEXT NOT NULL DEFAULT 'legacy'"
	);


	/*
	 * 索引
	 */

	db.exec(`

    CREATE INDEX IF NOT EXISTS
      idx_comments_monitor
      ON comments(monitor_id);


    CREATE INDEX IF NOT EXISTS
      idx_comments_comment_id
      ON comments(comment_id);


    CREATE INDEX IF NOT EXISTS
      idx_comments_time
      ON comments(comment_time);


    CREATE INDEX IF NOT EXISTS
      idx_api_responses_page
      ON api_responses(
        monitor_id,
        page_num
      );


    CREATE INDEX IF NOT EXISTS
      idx_api_responses_crawl_page
      ON api_responses(
        monitor_id,
        crawl_type,
        page_num
      );


    CREATE INDEX IF NOT EXISTS
      idx_daily_stats_monitor_date
      ON daily_stats(
        monitor_id,
        stat_date
      );

  `);
}


/**
 * ============================================================
 * Monitor
 * ============================================================
 */

function getMonitors(onlyEnabled = true) {

	initDatabase();

	if (onlyEnabled) {

		return db.prepare(`
      SELECT *
      FROM monitors
      WHERE enabled = 1
      ORDER BY id
    `).all();
	}


	return db.prepare(`
    SELECT *
    FROM monitors
    ORDER BY id
  `).all();
}


function getMonitor(id) {

	initDatabase();

	return db.prepare(`
    SELECT *
    FROM monitors
    WHERE id = ?
  `).get(id);
}


function getMonitorByUrl(url) {

	initDatabase();

	return db.prepare(`
    SELECT *
    FROM monitors
    WHERE url = ?
    LIMIT 1
  `).get(url);
}


function createMonitor({
	name,
	url,
	emojis = [],
	texts = [],
	enabled = true
}) {

	initDatabase();


	const result = db.prepare(`
    INSERT INTO monitors(
      name,
      url,
      emojis,
      texts,
      enabled,

      history_next_page,
      history_completed
    )
    VALUES(
      ?,?,?,?,?,
      1,0
    )
  `).run(

		name,

		url,

		JSON.stringify(
			emojis
		),

		JSON.stringify(
			texts
		),

		enabled
			? 1
			: 0
	);


	return Number(
		result.lastInsertRowid
	);
}


function updateMonitor(
	id,
	{
		name,
		url,
		emojis = [],
		texts = [],
		enabled = true
	}
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors
    SET
      name = ?,
      url = ?,
      emojis = ?,
      texts = ?,
      enabled = ?,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(

		name,

		url,

		JSON.stringify(
			emojis
		),

		JSON.stringify(
			texts
		),

		enabled
			? 1
			: 0,

		id
	);
}


/**
 * 旧页面兼容用。
 *
 * 真正的抓取状态现在已经拆成：
 *
 * latest_last_status
 * history_last_status
 */

function updateMonitorStatus(
	id,
	status
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      last_status = ?,

      last_run_at =
        CURRENT_TIMESTAMP,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(
		status,
		id
	);
}


/**
 * ============================================================
 * Latest 状态
 * ============================================================
 */

function updateLatestStatus(
	monitorId,
	status
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      latest_last_status = ?,

      latest_last_run_at =
        CURRENT_TIMESTAMP,

      last_status = ?,

      last_run_at =
        CURRENT_TIMESTAMP,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(

		status,

		status,

		monitorId
	);
}


/**
 * ============================================================
 * History 状态
 * ============================================================
 */

function updateHistoryStatus(
	monitorId,
	status
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      history_last_status = ?,

      history_last_run_at =
        CURRENT_TIMESTAMP,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(
		status,
		monitorId
	);
}


/**
 * History 下一页
 */

function setHistoryNextPage(
	monitorId,
	pageNum
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      history_next_page = ?,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(

		Number(
			pageNum
		),

		monitorId
	);
}


/**
 * History 全部完成
 */

function markHistoryCompleted(
	monitorId
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      history_completed = 1,

      history_last_status =
        'success',

      history_last_run_at =
        CURRENT_TIMESTAMP,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(
		monitorId
	);
}


/**
 * 如果以后你想手动重新补历史，
 * 可以调用这个。
 */

function resetHistoryProgress(
	monitorId,
	pageNum = 1
) {

	initDatabase();


	db.prepare(`
    UPDATE monitors

    SET
      history_next_page = ?,

      history_completed = 0,

      history_last_status = NULL,

      history_last_run_at = NULL,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
  `).run(

		Number(
			pageNum
		),

		monitorId
	);
}


/**
 * ============================================================
 * 第一次升级旧数据库时推导 History 断点
 * ============================================================
 *
 * 例如旧 api_responses：
 *
 * 1569 success
 * 1570 success
 * 1571 success
 * 1572 error
 *
 * 那么：
 *
 * history_next_page = 1572
 *
 *
 * 注意：
 *
 * 新版 latest 的 page 1 / 2 / 3
 * 绝对不能参与 History 断点计算。
 *
 * 所以这里只读取：
 *
 * legacy
 * history
 */

function getInitialHistoryPage(
	monitorId
) {

	initDatabase();


	const monitor =
		getMonitor(
			monitorId
		);


	if (!monitor) {

		throw new Error(
			`Monitor ${monitorId} 不存在`
		);
	}


	/*
	 * 已经有正式 History 断点，
	 * 直接使用。
	 */

	if (
		monitor.history_next_page !== null &&
		monitor.history_next_page !== undefined &&
		Number(
			monitor.history_next_page
		) >= 1
	) {

		return Number(
			monitor.history_next_page
		);
	}


	/*
	 * 第一次升级。
	 *
	 * 从旧 response 找最大成功页。
	 */

	const rows =
		db.prepare(`
      SELECT
        page_num,
        http_status,
        response_json,
        error_message,
        crawl_type

      FROM api_responses

      WHERE monitor_id = ?

        AND COALESCE(
          crawl_type,
          'legacy'
        )
        IN (
          'legacy',
          'history'
        )

      ORDER BY
        page_num DESC,
        id DESC
    `).all(
			monitorId
		);


	let maxSuccessfulPage = 0;


	for (
		const row of rows
	) {

		const hasError =
			row.error_message !== null &&
			row.error_message !== undefined &&
			String(
				row.error_message
			).trim() !== '';


		if (hasError) {
			continue;
		}


		if (
			!row.response_json
		) {
			continue;
		}


		/*
		 * HTTP 状态异常不算成功。
		 */

		if (
			row.http_status !== null &&
			(
				Number(
					row.http_status
				) < 200 ||

				Number(
					row.http_status
				) >= 300
			)
		) {

			continue;
		}


		/*
		 * 还要检查微博自己的：
		 *
		 * code === 100000
		 */

		try {

			const raw =
				JSON.parse(
					row.response_json
				);


			if (
				Number(
					raw?.code
				) !== 100000
			) {

				continue;
			}


			maxSuccessfulPage =
				Math.max(

					maxSuccessfulPage,

					Number(
						row.page_num
					) || 0
				);

		} catch {

			/*
			 * JSON 坏掉的旧 response
			 * 不作为成功页。
			 */

		}
	}


	const nextPage =

		maxSuccessfulPage > 0

			? maxSuccessfulPage + 1

			: 1;


	setHistoryNextPage(
		monitorId,
		nextPage
	);


	console.log(
		`Monitor ${monitorId} 初始化 History 断点：${nextPage}`
	);


	return nextPage;
}


/**
 * ============================================================
 * 删除 Monitor
 * ============================================================
 */

function deleteMonitor(id) {

	initDatabase();


	db.prepare(`
    DELETE FROM monitors
    WHERE id = ?
  `).run(
		id
	);
}


/**
 * ============================================================
 * Comments
 * ============================================================
 */

function normalizeNullable(
	value
) {

	if (
		value === null ||
		value === undefined ||
		value === ''
	) {

		return null;
	}


	return String(
		value
	);
}


/**
 * 单条保存。
 *
 * comment_id 已存在时：
 *
 * 不重复 INSERT。
 *
 * 但是如果旧记录缺：
 *
 * buyer_nickname
 * sku_name
 * comment_time
 *
 * 会自动补进去。
 *
 * 这正好兼容你之前那批
 * “没有用户名 / 评论时间”的数据。
 */

function saveComment(
	monitorId,
	comment
) {

	initDatabase();


	const commentId =
		String(

			comment.comment_id ??

			comment.commentId ??

			comment.id ??

			comment.cid ??

			''
		);


	if (!commentId) {

		return false;
	}


	const content =
		String(

			comment.content ??

			comment.text ??

			''
		);


	const commentTime =
		normalizeNullable(

			comment.comment_time ??

			comment.commentTime ??

			comment.time ??

			null
		);


	const buyerNickname =
		normalizeNullable(

			comment.buyer_nickname ??

			comment.buyerNickname ??

			comment.username ??

			null
		);


	const skuName =
		normalizeNullable(

			comment.sku_name ??

			comment.skuName ??

			comment.product ??

			null
		);


	db.prepare(`
    INSERT INTO comments(
      monitor_id,
      comment_id,

      buyer_nickname,
      sku_name,

      content,
      comment_time
    )

    VALUES(
      ?,?,?,?,?,?
    )


    ON CONFLICT(
      monitor_id,
      comment_id
    )

    DO UPDATE SET


      buyer_nickname =

        CASE

          WHEN
            comments.buyer_nickname
              IS NULL

            OR

            TRIM(
              comments.buyer_nickname
            ) = ''

          THEN
            excluded.buyer_nickname

          ELSE
            comments.buyer_nickname

        END,


      sku_name =

        CASE

          WHEN
            comments.sku_name
              IS NULL

            OR

            TRIM(
              comments.sku_name
            ) = ''

          THEN
            excluded.sku_name

          ELSE
            comments.sku_name

        END,


      comment_time =

        CASE

          WHEN
            comments.comment_time
              IS NULL

            OR

            TRIM(
              comments.comment_time
            ) = ''

          THEN
            excluded.comment_time

          ELSE
            comments.comment_time

        END,


      last_seen_at =
        CURRENT_TIMESTAMP

  `).run(

		monitorId,

		commentId,

		buyerNickname,

		skuName,

		content,

		commentTime
	);


	return true;
}


/**
 * 批量保存 Comments
 */

function saveComments(
	monitorId,
	comments
) {

	initDatabase();


	let count = 0;


	db.exec(
		'BEGIN'
	);


	try {

		for (
			const comment of comments || []
		) {

			if (
				saveComment(
					monitorId,
					comment
				)
			) {

				count++;
			}
		}


		db.exec(
			'COMMIT'
		);


		return count;

	} catch (error) {

		db.exec(
			'ROLLBACK'
		);


		throw error;
	}
}


/**
 * 最近 N 条
 */

function getComments(
	monitorId,
	limit = 100
) {

	initDatabase();


	return db.prepare(`
    SELECT *

    FROM comments

    WHERE monitor_id = ?

    ORDER BY

      CASE

        WHEN
          comment_time
          GLOB '[0-9]*'

        THEN
          CAST(
            comment_time
            AS INTEGER
          )

        ELSE
          0

      END DESC,

      id DESC

    LIMIT ?
  `).all(
		monitorId,
		limit
	);
}


/**
 * ============================================================
 * 全部 Comments
 * ============================================================
 *
 * 兼容：
 *
 * getAllComments()
 *
 * 以及：
 *
 * getAllComments(monitorId)
 *
 *
 * 之前你的 monitor.js 会传 monitorId，
 * 但旧 getAllComments 没有过滤，
 * 多 Monitor 时统计可能串掉。
 */

function getAllComments(
	monitorId = null
) {

	initDatabase();


	if (
		monitorId !== null &&
		monitorId !== undefined
	) {

		return db.prepare(`
      SELECT *

      FROM comments

      WHERE monitor_id = ?

      ORDER BY

        CASE

          WHEN
            comment_time
            GLOB '[0-9]*'

          THEN
            CAST(
              comment_time
              AS INTEGER
            )

          ELSE
            0

        END DESC,

        id DESC

    `).all(
			monitorId
		);
	}


	return db.prepare(`
    SELECT *

    FROM comments

    ORDER BY

      CASE

        WHEN
          comment_time
          GLOB '[0-9]*'

        THEN
          CAST(
            comment_time
            AS INTEGER
          )

        ELSE
          0

      END DESC,

      id DESC
  `).all();
}


/**
 * ============================================================
 * 获取某 Monitor 已有 comment_id
 * ============================================================
 *
 * Latest Batch 会在启动时调用一次，
 * 作为“本轮开始前数据库快照”。
 */

function getCommentIds(
	monitorId
) {

	initDatabase();


	const rows =
		db.prepare(`
      SELECT comment_id

      FROM comments

      WHERE monitor_id = ?
    `).all(
			monitorId
		);


	return new Set(

		rows.map(
			row =>
				String(
					row.comment_id
				)
		)
	);
}


/**
 * ============================================================
 * API Responses
 * ============================================================
 */

function saveApiResponse({
	monitorId,
	pageNum,
	apiUrl,

	httpStatus = null,

	responseData = null,

	errorMessage = null,

	crawlType = 'legacy'
}) {

	initDatabase();


	let responseJson = null;


	try {

		responseJson =

			responseData == null

				? null

				: JSON.stringify(
					responseData
				);

	} catch (error) {

		responseJson =
			JSON.stringify({
				serializationError:
					error.message
			});
	}


	const result =
		db.prepare(`
      INSERT INTO api_responses(
        monitor_id,

        page_num,

        api_url,

        http_status,

        response_json,

        error_message,

        crawl_type
      )

      VALUES(
        ?,?,?,?,?,?,?
      )
    `).run(

			monitorId,

			pageNum,

			apiUrl,

			httpStatus,

			responseJson,

			errorMessage,

			crawlType || 'legacy'
		);


	return Number(
		result.lastInsertRowid
	);
}


function getApiResponses(
	monitorId,
	limit = 500
) {

	initDatabase();


	return db.prepare(`
    SELECT
      ar.*,

      m.name
        AS monitor_name

    FROM api_responses ar

    LEFT JOIN monitors m
      ON m.id =
         ar.monitor_id

    WHERE
      ar.monitor_id = ?

    ORDER BY
      ar.id DESC

    LIMIT ?
  `).all(
		monitorId,
		limit
	);
}


function getAllApiResponses(
	limit = 500
) {

	initDatabase();


	return db.prepare(`
    SELECT
      ar.*,

      m.name
        AS monitor_name

    FROM api_responses ar

    LEFT JOIN monitors m
      ON m.id =
         ar.monitor_id

    ORDER BY
      ar.id DESC

    LIMIT ?
  `).all(
		limit
	);
}


function getApiResponseById(
	id
) {

	initDatabase();


	return db.prepare(`
    SELECT
      ar.*,

      m.name
        AS monitor_name

    FROM api_responses ar

    LEFT JOIN monitors m
      ON m.id =
         ar.monitor_id

    WHERE
      ar.id = ?
  `).get(
		id
	);
}


/**
 * 最近失败 response
 *
 * crawlType 可选：
 *
 * latest
 * history
 */

function getLatestFailedApiResponse(
	monitorId,
	crawlType = null
) {

	initDatabase();


	if (crawlType) {

		return db.prepare(`
      SELECT *

      FROM api_responses

      WHERE
        monitor_id = ?

        AND crawl_type = ?

        AND error_message
            IS NOT NULL

        AND TRIM(
              error_message
            ) <> ''

      ORDER BY
        id DESC

      LIMIT 1
    `).get(
			monitorId,
			crawlType
		);
	}


	return db.prepare(`
    SELECT *

    FROM api_responses

    WHERE
      monitor_id = ?

      AND error_message
          IS NOT NULL

      AND TRIM(
            error_message
          ) <> ''

    ORDER BY
      id DESC

    LIMIT 1
  `).get(
		monitorId
	);
}


/**
 * 最近一条 response
 */

function getLatestApiResponse(
	monitorId,
	crawlType = null
) {

	initDatabase();


	if (crawlType) {

		return db.prepare(`
      SELECT *

      FROM api_responses

      WHERE
        monitor_id = ?

        AND crawl_type = ?

      ORDER BY
        id DESC

      LIMIT 1
    `).get(
			monitorId,
			crawlType
		);
	}


	return db.prepare(`
    SELECT *

    FROM api_responses

    WHERE
      monitor_id = ?

    ORDER BY
      id DESC

    LIMIT 1
  `).get(
		monitorId
	);
}


/**
 * ============================================================
 * Daily Stats
 * ============================================================
 *
 * 正常调用：
 *
 * saveDailyStats(
 *   monitorId,
 *   stats
 * )
 *
 *
 * 同时兼容：
 *
 * saveDailyStats({
 *   monitorId,
 *   ...
 * })
 */

function saveDailyStats(
	monitorIdOrObject,
	maybeStats = null
) {

	initDatabase();


	let monitorId;

	let stats;


	if (
		typeof monitorIdOrObject ===
		'object' &&

		monitorIdOrObject !== null &&

		maybeStats === null
	) {

		monitorId =
			Number(
				monitorIdOrObject.monitorId
			);


		stats = {
			...monitorIdOrObject
		};


		delete stats.monitorId;

	} else {

		monitorId =
			Number(
				monitorIdOrObject
			);


		stats =
			maybeStats || {};
	}


	if (!monitorId) {

		throw new Error(
			'saveDailyStats 缺少 monitorId'
		);
	}


	const statDate =

		stats.statDate ||

		new Date()
			.toISOString()
			.slice(
				0,
				10
			);


	db.prepare(`
    INSERT INTO daily_stats(

      monitor_id,

      stat_date,

      total_comments,

      emoji_total,

      non_emoji_total,

      emoji_stats,

      text_stats
    )

    VALUES(
      ?,?,?,?,?,?,?
    )


    ON CONFLICT(
      monitor_id,
      stat_date
    )

    DO UPDATE SET

      total_comments =
        excluded.total_comments,

      emoji_total =
        excluded.emoji_total,

      non_emoji_total =
        excluded.non_emoji_total,

      emoji_stats =
        excluded.emoji_stats,

      text_stats =
        excluded.text_stats,

      updated_at =
        CURRENT_TIMESTAMP

  `).run(

		monitorId,

		statDate,

		stats.totalComments ??
		0,

		stats.emojiTotal ??
		0,

		stats.nonEmojiTotal ??
		0,

		JSON.stringify(
			stats.emojiStats ||
			{}
		),

		JSON.stringify(
			stats.textStats ||
			{}
		)
	);
}


function getDailyStats(
	monitorId,
	limit = 30
) {

	initDatabase();


	return db.prepare(`
    SELECT *

    FROM daily_stats

    WHERE
      monitor_id = ?

    ORDER BY
      stat_date DESC

    LIMIT ?
  `).all(
		monitorId,
		limit
	);
}


function getMonitorResult(
	monitorId
) {

	initDatabase();


	return db.prepare(`
    SELECT
      ds.*,

      m.name
        AS monitor_name

    FROM daily_stats ds

    LEFT JOIN monitors m
      ON m.id =
         ds.monitor_id

    WHERE
      ds.monitor_id = ?

    ORDER BY
      ds.stat_date DESC

    LIMIT 1
  `).get(
		monitorId
	);
}


/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {

	db,

	initDatabase,


	/*
	 * Monitor
	 */

	getMonitors,

	getMonitor,

	getMonitorByUrl,

	createMonitor,

	updateMonitor,

	updateMonitorStatus,

	deleteMonitor,


	/*
	 * Latest / History
	 */

	updateLatestStatus,

	updateHistoryStatus,

	setHistoryNextPage,

	markHistoryCompleted,

	resetHistoryProgress,

	getInitialHistoryPage,


	/*
	 * Comments
	 */

	saveComment,

	saveComments,

	getComments,

	getAllComments,

	getCommentIds,


	/*
	 * Responses
	 */

	saveApiResponse,

	getApiResponses,

	getAllApiResponses,

	getApiResponseById,

	getLatestFailedApiResponse,

	getLatestApiResponse,


	/*
	 * Stats
	 */

	saveDailyStats,

	getDailyStats,

	getMonitorResult
};
