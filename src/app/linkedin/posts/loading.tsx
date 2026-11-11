import { PageHeaderSkeleton, TableSkeleton } from "@/components/page/Skeletons";

// The LinkedIn layout already pads the page, so no PageContainer here.
export default function PostsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-[1440px] space-y-6">
      <PageHeaderSkeleton />
      <TableSkeleton rows={8} columns={5} />
    </div>
  );
}
