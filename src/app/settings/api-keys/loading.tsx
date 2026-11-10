import { ListSkeleton } from "@/components/settings/SettingsSkeletons";

export default function Loading() {
  return <ListSkeleton rows={3} withHeader />;
}
