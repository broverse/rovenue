import { useEffect, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Button, Spinner, TextField, Label, Input } from "@heroui/react";
import { useSubscribers } from "../../../../../lib/hooks/useSubscribers";
import { SubscribersTable } from "../../../../../components/subscribers/SubscribersTable";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/subscribers/",
)({
  component: SubscribersRouteComponent,
});

function SubscribersRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscribers/",
  });
  return <SubscribersPage projectId={projectId} />;
}

export function SubscribersPage({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useSubscribers({ projectId, q: debouncedQ || undefined });

  const loaderRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = data?.pages.flatMap((p) => p.subscribers) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Subscribers</h1>
        <TextField value={q} onChange={setQ} aria-label="Search">
          <Label className="sr-only">Search</Label>
          <Input placeholder="Search by app user id..." className="max-w-xs" />
        </TextField>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-default-500">
          <Spinner /> <span className="text-sm">Loading...</span>
        </div>
      )}
      {error && (
        <div role="alert" className="text-danger-500">
          {error.message}
        </div>
      )}
      {!isLoading && !error && (
        <SubscribersTable projectId={projectId} rows={rows} />
      )}

      <div ref={loaderRef} className="flex h-8 items-center justify-center">
        {isFetchingNextPage && <Spinner />}
        {!hasNextPage && rows.length > 0 && (
          <span className="text-xs text-default-400">End of list</span>
        )}
      </div>

      {hasNextPage && !isFetchingNextPage && (
        <Button
          variant="ghost"
          onPress={() => fetchNextPage()}
          className="self-center"
        >
          Load more
        </Button>
      )}
    </div>
  );
}
