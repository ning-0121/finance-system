-- 回滚 cost_items.supplier 三元组索引（保留 pg_trgm 扩展，可能被其它对象使用）
DROP INDEX IF EXISTS public.idx_cost_items_supplier_trgm;
