const {
  runHistoryBatch
} = require('./src/monitor');


async function main() {
  try {
    await runHistoryBatch(1);
  } catch (error) {
    console.error(
      'History 执行失败：',
      error
    );
  }
}


main();