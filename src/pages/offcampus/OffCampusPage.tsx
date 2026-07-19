import { Globe } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";

/** M9 校外（预留占位，形态待定）。 */
export function OffCampusPage() {
  return (
    <div className="flex h-full items-center justify-center bg-page pb-20">
      <EmptyState icon={<Globe size={26} />} title="校外" subtitle={"功能还在更新当中，\n以后再来吧！"} />
    </div>
  );
}
