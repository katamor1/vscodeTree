export async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = normalizeConcurrency(concurrency, items.length);
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export function normalizeConcurrency(value: number, itemCount = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(Math.floor(value), Math.max(1, itemCount)));
}
