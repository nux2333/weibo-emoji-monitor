const {
	db,
	initDatabase
} = require('./db');


function isSuccessfulResponse(
	raw
) {

	return (
		raw &&
		Number(
			raw.code
		) === 100000
	);
}


function extractComments(
	raw
) {

	if (
		!raw ||
		typeof raw !== 'object'
	) {
		return [];
	}

	if (
		Array.isArray(
			raw?.data?.data?.result
		)
	) {
		return raw.data.data.result;
	}

	if (
		Array.isArray(
			raw?.data?.result
		)
	) {
		return raw.data.result;
	}

	if (
		Array.isArray(
			raw?.result
		)
	) {
		return raw.result;
	}

	return [];
}


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

	const text =
		String(value).trim();

	if (
		/^\d{13}$/.test(
			text
		)
	) {
		return text;
	}

	if (
		/^\d{10}$/.test(
			text
		)
	) {
		return String(
			Number(text) *
			1000
		);
	}

	return text;
}


function getCommentId(
	comment
) {

	const value =
		comment?.comment_id ??
		comment?.commentId ??
		comment?.id ??
		comment?.cid;

	if (
		value === null ||
		value === undefined ||
		value === ''
	) {
		return null;
	}

	return String(value);
}


function getBuyerNickname(
	comment
) {

	const value =
		comment?.buyer_nickname ??
		comment?.buyerNickname ??
		comment?.username ??
		null;

	if (
		value === null ||
		value === undefined ||
		value === ''
	) {
		return null;
	}

	return String(value);
}


function getSkuName(
	comment
) {

	const value =
		comment?.sku_name ??
		comment?.skuName ??
		comment?.product ??
		null;

	if (
		value === null ||
		value === undefined ||
		value === ''
	) {
		return null;
	}

	return String(value);
}


function getContent(
	comment
) {

	return String(
		comment?.content ??
		comment?.text ??
		''
	);
}


function getCommentTime(
	comment
) {

	return normalizeCommentTime(
		comment?.comment_time ??
		comment?.commentTime ??
		comment?.time ??
		null
	);
}


function getResponseRows({
	monitorId = null,
	responseId = null
} = {}) {

	if (responseId) {

		return db.prepare(`
      SELECT *
      FROM api_responses
      WHERE id = ?
      ORDER BY id
    `).all(
			responseId
		);
	}


	if (monitorId) {

		return db.prepare(`
      SELECT *
      FROM api_responses
      WHERE monitor_id = ?
      ORDER BY id
    `).all(
			monitorId
		);
	}


	return db.prepare(`
    SELECT *
    FROM api_responses
    ORDER BY id
  `).all();
}


function rebuildComments({
	monitorId = null,
	responseId = null
} = {}) {

	initDatabase();

	const responses =
		getResponseRows({
			monitorId,
			responseId
		});


	const existsStmt =
		db.prepare(`
	    SELECT
	      id,
	      buyer_nickname,
	      sku_name,
	      comment_time
	    FROM comments
	    WHERE comment_id = ?
	    LIMIT 1
	  `);


	const insertStmt =
		db.prepare(`
      INSERT INTO comments(
        monitor_id,
        comment_id,
        buyer_nickname,
        sku_name,
        content,
        comment_time
      )
      VALUES(?,?,?,?,?,?)
    `);


	/**
	 * 历史 comments 已经存在时，
	 * 不重新生成、不覆盖正文，
	 * 只允许补齐旧表缺失的用户名/商品字段。
	 */
	const backfillStmt =
		db.prepare(`
      UPDATE comments
      SET
        buyer_nickname =
          CASE
            WHEN buyer_nickname IS NULL
              OR TRIM(buyer_nickname) = ''
            THEN ?
            ELSE buyer_nickname
          END,

        sku_name =
          CASE
            WHEN sku_name IS NULL
              OR TRIM(sku_name) = ''
            THEN ?
            ELSE sku_name
          END,

        comment_time =
          CASE
            WHEN comment_time IS NULL
              OR TRIM(comment_time) = ''
            THEN ?
            ELSE comment_time
          END

      WHERE id = ?
    `);


	let parsedCommentCount = 0;
	let insertedCount = 0;
	let skippedCount = 0;
	let invalidCommentCount = 0;
	let insertErrorCount = 0;
	let backfilledCount = 0;
	let skippedResponseCount = 0;


	db.exec(
		'BEGIN'
	);

	try {

		for (
			const row
			of responses
		) {

			const hasError =
				row.error_message !== null &&
				row.error_message !== undefined &&
				String(
					row.error_message
				).trim() !== '';

			if (hasError) {

				skippedResponseCount++;

				continue;
			}


			if (
				!row.response_json
			) {

				skippedResponseCount++;

				continue;
			}


			let raw;

			try {

				raw =
					JSON.parse(
						row.response_json
					);

			} catch {

				skippedResponseCount++;

				continue;
			}


			if (
				!isSuccessfulResponse(
					raw
				)
			) {

				skippedResponseCount++;

				continue;
			}


			const comments =
				extractComments(
					raw
				);

			parsedCommentCount +=
				comments.length;


			for (
				const comment
				of comments
			) {

				const commentId =
					getCommentId(
						comment
					);


				if (!commentId) {

					invalidCommentCount++;

					continue;
				}


				const buyerNickname =
					getBuyerNickname(
						comment
					);

				const skuName =
					getSkuName(
						comment
					);

				const commentTime =
					getCommentTime(comment);

				const exists =
					existsStmt.get(
						commentId
					);


				if (exists) {
					skippedCount++;

					if (
					  (
					    !exists.buyer_nickname &&
					    buyerNickname
					  ) ||
					  (
					    !exists.sku_name &&
					    skuName
					  ) ||
					  (
					    !exists.comment_time &&
					    commentTime
					  )
					) {
					  backfillStmt.run(
					    buyerNickname,
					    skuName,
					    commentTime,
					    exists.id
					  );

					  backfilledCount++;
					}

					continue;
				}


				try {

					insertStmt.run(
					  row.monitor_id,
					  commentId,
					  buyerNickname,
					  skuName,
					  getContent(comment),
					  commentTime
					);

					insertedCount++;

				} catch (error) {

					insertErrorCount++;

					console.error(
						`comments INSERT 失败，comment_id=${commentId}:`,
						error.message
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


	const result = {
		responseCount:
			responses.length,

		skippedResponseCount,

		parsedCommentCount,

		insertedCount,

		skippedCount,

		backfilledCount,

		invalidCommentCount,

		insertErrorCount
	};


	console.log(
		'========== rebuild-comments =========='
	);

	console.log(
		JSON.stringify(
			result,
			null,
			2
		)
	);

	console.log(
		'======================================'
	);


	return result;
}


if (
	require.main === module
) {

	try {

		const result =
			rebuildComments();

		console.log(
			'rebuild-comments 完成：',
			result
		);

	} catch (error) {

		console.error(
			'rebuild-comments 失败：',
			error
		);

		process.exitCode = 1;
	}
}


module.exports = {
	rebuildComments,
	extractComments,
	normalizeCommentTime,
	isSuccessfulResponse
};
