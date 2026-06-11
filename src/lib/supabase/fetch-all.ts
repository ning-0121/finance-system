// ============================================================
// 全量分页读取 — 规避 PostgREST 默认 max-rows=1000 的静默截断
// 财务聚合/导出/预加载必须用本函数，禁止裸 .select() 取"全表"。
// 用法：传一个"按页构造查询"的闭包（每页必须重新构造 builder，
// 且查询自身需带稳定排序，否则分页窗口不可靠）。
// ============================================================

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

const PAGE_SIZE = 1000

export async function fetchAll<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildPage(from, from + PAGE_SIZE - 1)
    if (error) return { data: all, error }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return { data: all, error: null }
}
