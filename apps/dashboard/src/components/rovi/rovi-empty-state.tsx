export function RoviEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 rounded-full bg-rv-c2 p-3 text-rv-mute-600">
        <span className="text-lg" aria-hidden="true">✨</span>
      </div>
      <p className="text-sm font-medium text-foreground">Ask Rovi</p>
      <p className="mt-1 max-w-[260px] text-xs text-rv-mute-600">
        Subscribers, products, audiences, experiments — ask a question or kick off an
        action. Mutations always ask for your approval first.
      </p>
    </div>
  );
}
