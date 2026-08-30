/**

* 判断一条评论是否包含指定 Emoji / 文本
*
* 重要规则：
*
* 😂😂😂
*
* 指定 😂
*
* 结果：
* 😂 = 1
*
* 而不是 3
  */

function analyzeComment(
content,
emojis = [],
texts = []
) {

const emojiStats = {};
const textStats = {};

const text = String(content || '');

/**

* Emoji
  */
  for (const emoji of emojis) {


if (!emoji) {



  continue;
}

emojiStats[emoji] =
  text.includes(emoji) ? 1 : 0;


}

/**

* 文本
  */
  for (const keyword of texts) {


if (!keyword) {



  continue;
}

textStats[keyword] =
  text.includes(keyword) ? 1 : 0;


}

/**

* 这一条评论有没有至少命中一个条件
  */
  const matchedEmoji =
  Object.values(emojiStats)
  .some(value => value === 1);

const matchedText =
Object.values(textStats)
.some(value => value === 1);

return {


emojiStats,

textStats,

matched:
  matchedEmoji || matchedText


};
}

/**

* 对整个评论列表进行统计
  */
  function analyzeComments(
  comments,
  emojis = [],
  texts = []
  ) {

const emojiStats = {};
const textStats = {};

/**

* 初始化
  */
  for (const emoji of emojis) {


if (emoji) {



  emojiStats[emoji] = 0;
}


}

for (const keyword of texts) {


if (keyword) {
  textStats[keyword] = 0;
}


}

let matchedComments = 0;

/**

* 每条评论单独判断
  */
  for (const comment of comments) {


const result =



  analyzeComment(
    comment.content,
    emojis,
    texts
  );


let matched = false;


/**
 * Emoji
 */
for (const emoji of emojis) {

  if (
    result.emojiStats[emoji] === 1
  ) {

    emojiStats[emoji]++;

    matched = true;
  }
}


/**
 * 文本
 */
for (const keyword of texts) {

  if (
    result.textStats[keyword] === 1
  ) {

    textStats[keyword]++;

    matched = true;
  }
}


/**
 * 一条评论无论命中几个关键词
 * matchedComments 都只 +1
 */
if (matched) {
  matchedComments++;
}


}

const totalComments =
comments.length;

const unmatchedComments =
totalComments -
matchedComments;

const emojiTotal =
Object.values(emojiStats)
.reduce(
(sum, value) => sum + value,
0
);

const textTotal =
Object.values(textStats)
.reduce(
(sum, value) => sum + value,
0
);

return {

totalComments,

matchedComments,

unmatchedComments,

emojiTotal,

textTotal,

keywordTotal:
  emojiTotal + textTotal,

emojiStats,

textStats

};
}

module.exports = {
analyzeComment,
analyzeComments
};
