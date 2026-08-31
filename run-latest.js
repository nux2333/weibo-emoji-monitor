const {
  runLatestBatch
} = require('./src/monitor');


async function main() {

  const monitorId =
    Number(process.argv[2] || 1);

  console.log(
    `手动启动 Latest Batch，monitorId=${monitorId}`
  );

  try {

    const result =
      await runLatestBatch(monitorId);

    console.log(
      'Latest Batch 执行完成：',
      result
    );

  } catch (error) {

    console.error(
      'Latest Batch 执行失败：',
      error
    );

    process.exitCode = 1;
  }
}


main();