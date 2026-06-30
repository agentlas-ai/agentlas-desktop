// 무제한 Promise.all / 순차 for-await 를 bounded 동시성으로 바꾸기 위한 공유 헬퍼.
// 결과 순서는 입력 순서를 보존한다(인덱스 기반으로 슬롯에 기록).
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // limit 가 0 이하로 들어와도 최소 1개는 돌도록 방어.
  const max = Math.max(1, Math.floor(limit));
  let cursor = 0;

  async function runner(): Promise<void> {
    // 각 워커가 다음 인덱스를 집어 처리, 큐가 비면 종료.
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const runnerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  return results;
}
