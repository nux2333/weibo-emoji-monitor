/** Pure post parsing and helper functions. */

function stripHtml(value) {
  if (value == null) {
    return '';
  }

  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function getPostId(post) {
  const value =
    post?.idstr
    ?? post?.mid
    ?? post?.id;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUid(post) {
  const value =
    post?.user?.idstr
    ?? post?.user?.id
    ?? post?.uid;

  return (
    value === null ||
    value === undefined ||
    value === ''
  )
    ? ''
    : String(value);
}

function getUsername(post) {
  return (
    post?.user?.screen_name
    ?? post?.user?.name
    ?? null
  );
}

function getPostText(post) {
  return stripHtml(
    post?.text
    ?? post?.raw_text
    ?? post?.text_raw
    ?? ''
  );
}

function getCommentsCount(post) {
  const value =
    post?.comments_count
    ?? post?.comment_count;

  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function getPostCreatedAt(post) {
  const value =
    post?.created_at
    ?? post?.createdAt
    ?? null;

  return value
    ? String(value)
    : null;
}

function getPostLink(post) {
  const uid =
    getUid(post);

  const postId =
    getPostId(post);

  if (
    !uid ||
    !postId
  ) {
    return '';
  }

  return `https://weibo.com/${uid}/${postId}`;
}

function looksLikePost(obj) {
  if (
    !obj
    ||
    typeof obj !== 'object'
    ||
    Array.isArray(obj)
  ) {
    return false;
  }

  const postId =
    obj.idstr
    ?? obj.mid
    ?? obj.id;

  if (
    !postId
    ||
    !obj.user
  ) {
    return false;
  }

  return (
    obj.comments_count !== undefined
    ||
    obj.comment_count !== undefined
    ||
    obj.text !== undefined
    ||
    obj.raw_text !== undefined
    ||
    obj.text_raw !== undefined
    ||
    obj.reposts_count !== undefined
    ||
    obj.attitudes_count !== undefined
  );
}

function findPosts(
  value,
  result = [],
  visited = new Set()
) {
  if (
    !value
    ||
    typeof value !== 'object'
    ||
    visited.has(value)
  ) {
    return result;
  }

  visited.add(value);

  if (looksLikePost(value)) {
    result.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findPosts(
        item,
        result,
        visited
      );
    }

    return result;
  }

  for (
    const child
    of Object.values(value)
  ) {
    if (
      child
      &&
      typeof child === 'object'
    ) {
      findPosts(
        child,
        result,
        visited
      );
    }
  }

  return result;
}

function hasSuperLike(post) {
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  if (
    icons.some(
      icon =>
        String(
          icon?.name || ''
        ).toLowerCase()
        === 'chao_like'
    )
  ) {
    return true;
  }

  let text = '';

  try {
    text =
      JSON.stringify(
        post?.user || {}
      ).toLowerCase();

  } catch {
    return false;
  }

  return (
    text.includes('"name":"chao_like"')
    ||
    text.includes('"name":"chaolike"')
    ||
    text.includes('"name":"super_like"')
    ||
    text.includes('"name":"superlike"')
  );
}

function extractIcons(post) {
  const icons =
    Array.isArray(
      post?.user?.icons
    )
      ? post.user.icons
      : [];

  return icons
    .map(
      icon =>
        String(
          icon?.name || ''
        ).trim()
    )
    .filter(Boolean)
    .filter(
      name =>
        name.toLowerCase()
        !== 'chao_like'
    );
}

function parsePostCreatedAtMs(post) {
  const raw =
    getPostCreatedAt(post);

  if (!raw) {
    return null;
  }

  const ms =
    Date.parse(raw);

  return Number.isFinite(ms)
    ? ms
    : null;
}

function getNewestPostInfo(posts) {
  let best = null;

  for (
    const post
    of posts
  ) {
    const postId =
      getPostId(post);

    const createdAt =
      getPostCreatedAt(post);

    const createdAtMs =
      parsePostCreatedAtMs(post);

    if (
      !postId
      ||
      !Number.isFinite(
        Number(createdAtMs)
      )
    ) {
      continue;
    }

    if (
      !best
      ||
      createdAtMs >
        best.createdAtMs
    ) {
      best = {
        postId,
        createdAt,
        createdAtMs
      };
    }
  }

  return best;
}

function shouldStopAtCheckpoint(
  post,
  checkpoint
) {
  if (
    !checkpoint
    ||
    !checkpoint.latest_post_id
  ) {
    return false;
  }

  const postId =
    getPostId(post);

  if (!postId) {
    return false;
  }

  return (
    String(postId) ===
    String(checkpoint.latest_post_id)
  );
}

module.exports = {
  stripHtml,
  getPostId,
  getUid,
  getUsername,
  getPostText,
  getCommentsCount,
  getPostCreatedAt,
  getPostLink,
  looksLikePost,
  findPosts,
  hasSuperLike,
  extractIcons,
  parsePostCreatedAtMs,
  getNewestPostInfo,
  shouldStopAtCheckpoint
};
