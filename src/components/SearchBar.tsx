import SearchInput from './SearchInput';

export default function SearchBar({
  search,
  isStuck,
  pillClicked,
  onSearch,
  onPillClick,
  onBlur,
}: {
  search: string;
  isStuck: boolean;
  pillClicked: boolean;
  onSearch: (value: string) => void;
  onPillClick: () => void;
  onBlur: () => void;
}) {
  const showPill = isStuck && !pillClicked && !!search;

  return (
    <div className="relative">
      {/* Input — fades out when pill shows */}
      <div
        className="transition-opacity duration-300"
        style={{
          opacity: showPill ? 0 : 1,
          pointerEvents: showPill ? 'none' : 'auto',
        }}
      >
        <SearchInput
          autoFocus={!isStuck && search.length < 3}
          focus={pillClicked}
          defaultValue={search}
          onChange={onSearch}
          onBlur={isStuck ? onBlur : undefined}
          placeholder="search company..."
        />
      </div>

      {/* Pill — fades in and shrinks when stuck */}
      <div
        className="absolute left-0 top-0 origin-top-left transition-all duration-200 ease-out"
        style={{
          opacity: showPill ? 1 : 0,
          pointerEvents: showPill ? 'auto' : 'none',
          transform: showPill ? 'scale(0.65)' : 'scale(1)',
        }}
      >
        <button
          type="button"
          onClick={onPillClick}
          className="inline-flex items-center whitespace-nowrap rounded-full bg-(--sea-ink) px-4 py-3 text-lg text-(--surface) transition hover:opacity-85"
        >
          <span className="max-w-72 truncate">{search}</span>
        </button>
      </div>
    </div>
  );
}
