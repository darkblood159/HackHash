// src/components/EntriesSortSelect.tsx
//
// /entries' "Sort by" dropdown: the shared SortSelect fed with this page's
// own option list (src/lib/entriesSort.ts). Behavior notes live on
// SortSelect.
import { SortSelect } from '@/components/SortSelect';
import { ENTRIES_SORTS, ENTRIES_SORT_LABELS, DEFAULT_ENTRIES_SORT, type EntriesSort } from '@/lib/entriesSort';

const OPTIONS = ENTRIES_SORTS.map((value) => ({ value, label: ENTRIES_SORT_LABELS[value] }));

export function EntriesSortSelect({ current }: { current: EntriesSort }) {
  return <SortSelect current={current} options={OPTIONS} defaultValue={DEFAULT_ENTRIES_SORT} />;
}
