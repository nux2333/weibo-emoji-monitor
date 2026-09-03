function escapeHtml(
  value
) {

  return String(
    value ?? ''
  )
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#039;'
    );
}


function formatTime(
  value
) {

  if (!value) {
    return '-';
  }


  /*
   * SQLite CURRENT_TIMESTAMP
   * 是UTC。
   *
   * 补Z让浏览器按UTC解析，
   * 然后显示本地时间。
   */
  const normalized =
    value.includes('T')
      ? value
      : value.replace(
          ' ',
          'T'
        ) + 'Z';


  const date =
    new Date(
      normalized
    );


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return value;
  }


  return date
    .toLocaleString(
      'zh-CN'
    );
}


async function loadData() {

  const keyword =
    document
      .getElementById(
        'keyword'
      )
      .value
      .trim();


  const params =
    new URLSearchParams();


  if (keyword) {

    params.set(
      'keyword',
      keyword
    );
  }


  const response =
    await fetch(
      '/api/superlike-posts?' +
      params.toString()
    );


  const json =
    await response.json();


  if (!json.success) {

    alert(
      json.message ||
      '读取失败'
    );

    return;
  }


  const stats =
    json.stats || {};


  document
    .getElementById(
      'totalCount'
    )
    .textContent =
      stats.total ?? 0;


  document
    .getElementById(
      'userCount'
    )
    .textContent =
      stats.user_count ?? 0;


  document
    .getElementById(
      'experienceKnown'
    )
    .textContent =
      stats.experience_known ?? 0;


  const tbody =
    document
      .getElementById(
        'tbody'
      );


  tbody.innerHTML = '';


  for (
    const row
    of json.data || []
  ) {

    const tr =
      document.createElement(
        'tr'
      );


    const icon =
      row.icon_summary &&
      row.icon_summary !== '无'

        ? `
          <span class="icon-tag">
            ${escapeHtml(
              row.icon_summary
            )}
          </span>
        `

        : `
          <span class="no-icon">
            无
          </span>
        `;


    const experience =
      row.experience_7d === null ||
      row.experience_7d === undefined

        ? `
          <span class="unknown-exp">
            —
          </span>
        `

        : escapeHtml(
            row.experience_7d
          );


    tr.innerHTML = `

      <td class="uid">
        ${escapeHtml(
          row.uid || '-'
        )}
      </td>


      <td>
        ${escapeHtml(
          row.username || '-'
        )}
      </td>


      <td class="post-text">
        ${escapeHtml(
          row.post_text || ''
        )}
      </td>


      <td class="comment-low">
        ${escapeHtml(
          row.comments_count
        )}
      </td>


      <td>
        ${icon}
      </td>


      <td>
        ${experience}
      </td>


      <td class="time">
        ${escapeHtml(
          formatTime(
            row.first_seen_at
          )
        )}
      </td>


      <td class="time">
        ${escapeHtml(
          formatTime(
            row.last_seen_at
          )
        )}
      </td>


      <td>

        ${
          row.post_link

            ? `
              <a
                class="link-button"
                href="${escapeHtml(
                  row.post_link
                )}"
                target="_blank"
                rel="noopener noreferrer"
              >
                打开帖子
              </a>
            `

            : '-'
        }

      </td>
    `;


    tbody.appendChild(
      tr
    );
  }
}


function clearSearch() {

  document
    .getElementById(
      'keyword'
    )
    .value = '';


  loadData();
}


document
  .getElementById(
    'keyword'
  )
  .addEventListener(
    'keydown',
    event => {

      if (
        event.key === 'Enter'
      ) {

        loadData();
      }
    }
  );


loadData();


/*
 * 页面每30秒自动刷新一次
 */
setInterval(
  loadData,
  30000
);