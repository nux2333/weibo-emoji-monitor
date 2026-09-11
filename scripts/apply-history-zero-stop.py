from pathlib import Path

path = Path('src/superlike/monitor-scanner.js')
s = path.read_text(encoding='utf-8')

if 'HISTORY_ZERO_POST_THRESHOLD' in s:
    print('already patched')
    raise SystemExit(0)

old = """const HISTORY_OLD_PAGE_THRESHOLD =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_HISTORY_OLD_PAGE_THRESHOLD
    )
    || 1
  );
"""
new = old + """

/*
 * latest-posts History 防空扫：连续多页最终可处理 Post=0 时停止，
 * 避免日期解析异常/重复数据导致旧 Resume 无限往后翻页。
 */
const HISTORY_ZERO_POST_THRESHOLD =
  Math.max(
    1,
    Number(
      process.env.SUPERLIKE_HISTORY_ZERO_POST_THRESHOLD
    )
    || 3
  );
"""
if old not in s:
    raise SystemExit('anchor 1 not found')
s = s.replace(old, new, 1)

old = """      const historyCutoffMs =
        getChinaYesterdayStartMs();

      let consecutiveOldPages = 0;

      console.log(
"""
new = """      const historyCutoffMs =
        getChinaYesterdayStartMs();

      let consecutiveOldPages = 0;
      let consecutiveZeroPostPages = 0;

      console.log(
"""
if old not in s:
    raise SystemExit('anchor 2 not found')
s = s.replace(old, new, 1)

old = """        console.log(
          [
            `[History latest-posts #${historyPage}]`,
            `page=${params.page}`,
            `Post=${pageStats.found}`,
            `Profile查=${pageStats.profileChecked}`,
            `新增=${pageStats.inserted}`,
            `更新UID=${pageStats.replaced}`,
            `过期跳过=${pageStats.olderThanMinCreatedAt || 0}`
          ].join(' | ')
        );

        if (ageState.fullyOlder) {
"""
new = """        console.log(
          [
            `[History latest-posts #${historyPage}]`,
            `page=${params.page}`,
            `Post=${pageStats.found}`,
            `Profile查=${pageStats.profileChecked}`,
            `新增=${pageStats.inserted}`,
            `更新UID=${pageStats.replaced}`,
            `过期跳过=${pageStats.olderThanMinCreatedAt || 0}`
          ].join(' | ')
        );

        if (Number(pageStats.found || 0) === 0) {
          consecutiveZeroPostPages++;

          console.log(
            `[SuperLike][History][空页] page=${params.page} | Post=0 | 连续空页=${consecutiveZeroPostPages}/${HISTORY_ZERO_POST_THRESHOLD}`
          );
        } else {
          if (consecutiveZeroPostPages > 0) {
            console.log(
              `[SuperLike][History][空页] page=${params.page} 恢复有效Post；连续空页 ${consecutiveZeroPostPages} -> 0`
            );
          }

          consecutiveZeroPostPages = 0;
        }

        if (
          consecutiveZeroPostPages
          >= HISTORY_ZERO_POST_THRESHOLD
        ) {
          clearScanResume(
            monitor.id
          );

          console.log(
            `[SuperLike][History][空扫停止] 连续 ${HISTORY_ZERO_POST_THRESHOLD} 页 Post=0，清除 latest-posts Resume 并结束 History。`
          );

          break;
        }

        if (ageState.fullyOlder) {
"""
if old not in s:
    raise SystemExit('anchor 3 not found')
s = s.replace(old, new, 1)

path.write_text(s, encoding='utf-8')
print('patched', path)
