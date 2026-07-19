import { Search } from "lucide-react";

export function SearchInput({
  value,
  onChange,
  placeholder = "搜索地点 / 楼宇 / 设施",
  onFocus,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onFocus?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex h-11 items-center gap-2 rounded-full bg-page px-4">
      <Search size={17} className="shrink-0 text-sub" />
      <input
        className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-sub"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        placeholder={placeholder}
        autoFocus={autoFocus}
        enterKeyHint="search"
      />
    </div>
  );
}
