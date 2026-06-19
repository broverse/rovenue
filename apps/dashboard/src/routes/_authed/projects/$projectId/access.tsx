import { useMemo, useState } from "react";
import type { DashboardProductRow } from "@rovenue/shared";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useCreateAccess,
  useProjectAccess,
  useUpdateAccess,
} from "../../../../lib/hooks/useProjectAccess";
import {
  useProjectProducts,
  useUpdateProduct,
} from "../../../../lib/hooks/useProjectProducts";
import {
  AccessDetail,
  AccessFormDialog,
  AccessList,
  DeleteAccessDialog,
  LinkProductsModal,
} from "../../../../components/access";

interface Search {
  accessId?: string;
}

export const Route = createFileRoute("/_authed/projects/$projectId/access")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    accessId: typeof s.accessId === "string" ? s.accessId : undefined,
  }),
  component: AccessRoute,
});

function AccessRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/access",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AccessPage projectId={projectId} />;
}

function AccessPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = Route.useNavigate();
  const { accessId: selectedId } = Route.useSearch();

  const accessQuery = useProjectAccess(projectId);
  const rows = accessQuery.data?.rows ?? [];
  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const productsQuery = useProjectProducts({ projectId, limit: 200 });
  const allProducts = useMemo(
    () => productsQuery.data?.pages.flatMap((p) => p.products) ?? [],
    [productsQuery.data],
  );
  const grantingProducts = useMemo(
    () =>
      selected
        ? allProducts.filter((p) => p.accessIds.includes(selected.id))
        : [],
    [allProducts, selected],
  );

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const updateProduct = useUpdateProduct(projectId);

  async function unlinkProduct(product: DashboardProductRow) {
    if (!selected) return;
    setUnlinkError(null);
    try {
      await updateProduct.mutateAsync({
        id: product.id,
        accessIds: product.accessIds.filter((id) => id !== selected.id),
      });
    } catch (e) {
      setUnlinkError(
        e instanceof Error
          ? e.message
          : t("access.grantingProducts.unlinkError", "Could not unlink the product. Please try again."),
      );
    }
  }

  const create = useCreateAccess(projectId);
  const update = useUpdateAccess(projectId, selected?.id ?? "");

  function select(id: string | null) {
    void navigate({
      search: (): Search => (id ? { accessId: id } : { accessId: undefined }),
    });
  }

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("access.title", "Access")}
          </h1>
          <p className="mt-0.5 max-w-[640px] text-[13px] text-rv-mute-500">
            {t(
              "access.subtitle",
              "Access levels are the capabilities subscribers unlock — like Pro or Premium. A product grants one on purchase; your SDK checks it to gate features.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("access.actions.guide", "Guide")}
          </Button>
          <Button
            variant="solid-primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={13} />
            {t("access.actions.new", "New access")}
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:gap-5 max-xl:lg:grid-cols-[260px_minmax(0,1fr)]">
        <AccessList
          rows={rows}
          selectedId={selected?.id ?? null}
          onSelect={select}
          search={search}
          onSearchChange={setSearch}
          onCreate={() => setCreateOpen(true)}
        />

        <AccessDetail
          accessRow={selected}
          grantingProducts={grantingProducts}
          hasAnyAccess={rows.length > 0}
          onEdit={() => setEditOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onCreate={() => setCreateOpen(true)}
          onLinkProducts={() => setLinkOpen(true)}
          onUnlinkProduct={(product) => void unlinkProduct(product)}
          unlinkError={unlinkError}
        />
      </div>

      <AccessFormDialog
        open={createOpen}
        mode="create"
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onSave={async (body) => {
          const row = await create.mutateAsync(body);
          select(row.id);
          setCreateOpen(false);
        }}
      />

      {selected && (
        <AccessFormDialog
          open={editOpen}
          mode="edit"
          projectId={projectId}
          initial={{
            identifier: selected.identifier,
            displayName: selected.displayName,
            description: selected.description,
          }}
          onClose={() => setEditOpen(false)}
          onSave={async (body) => {
            await update.mutateAsync(body);
            setEditOpen(false);
          }}
        />
      )}

      <DeleteAccessDialog
        projectId={projectId}
        accessRow={selected}
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => select(null)}
      />

      <LinkProductsModal
        open={linkOpen}
        projectId={projectId}
        access={selected}
        products={allProducts}
        onClose={() => setLinkOpen(false)}
      />
    </>
  );
}
