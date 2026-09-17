"use client";

/* eslint-disable @next/next/no-img-element */
import { tenantDateTimeFormatter } from "@/lib/client-timezone";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ErpIcon } from "./erp-icon";
import { ErpModal } from "./modal-portal";
import styles from "./media-library.module.css";

export type MediaAsset = {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  kind: "image" | "document" | "video";
  sizeBytes: number;
  altText: string;
  description: string | null;
  tags: string[];
  folder: string;
  source: string;
  version: number;
  expiresAt: string | null;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  favorite: boolean;
  versionCount: number;
  duplicateCount: number;
  usageCount: number;
  url: string;
};

type MediaFolder = {
  id: number;
  name: string;
  slug: string;
  color: string;
  system: boolean;
  count: number;
};
type Summary = {
  total: number;
  images: number;
  videos: number;
  documents: number;
  sizeBytes: number;
  quotaBytes: number;
  trash: number;
  unused: number;
  missingAlt: number;
  favorites: number;
};
type Pagination = {
  page: number;
  perPage: number;
  total: number;
  pages: number;
};
type Tag = { name: string; count: number };
type ViewMode = "grid" | "list";
type LibraryResponse = {
  items: MediaAsset[];
  folders: MediaFolder[];
  summary: Summary;
  pagination: Pagination;
  tags: Tag[];
  capabilities: { canWrite: boolean };
  error?: string;
};
type Detail = {
  asset: MediaAsset;
  usage: { key: string; label: string; count: number }[];
  versions: {
    id: number | null;
    version: number;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedByName: string;
    changeNote?: string | null;
    createdAt: string;
    current: boolean;
    url: string;
  }[];
  audit: {
    id: string;
    actorId: string | null;
    action: string;
    createdAt: string;
  }[];
};

const emptySummary: Summary = {
  total: 0,
  images: 0,
  videos: 0,
  documents: 0,
  sizeBytes: 0,
  quotaBytes: 1,
  trash: 0,
  unused: 0,
  missingAlt: 0,
  favorites: 0,
};
const emptyPagination: Pagination = {
  page: 1,
  perPage: 24,
  total: 0,
  pages: 1,
};

export function MediaLibrary({
  picker = false,
  acceptKind = "all",
  onSelect,
  onClose,
}: {
  picker?: boolean;
  acceptKind?: "all" | "image" | "document" | "video";
  onSelect?: (asset: MediaAsset) => void;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [pagination, setPagination] = useState<Pagination>(emptyPagination);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState(acceptKind);
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("recent");
  const [trash, setTrash] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [unused, setUnused] = useState(false);
  const [missingAlt, setMissingAlt] = useState(false);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<ViewMode>("grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<MediaFolder>();
  const [editing, setEditing] = useState<MediaAsset>();
  const [detail, setDetail] = useState<MediaAsset>();
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canWrite, setCanWrite] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({
        page: String(page),
        per_page: picker ? "40" : "24",
        sort,
      });
      if (query.trim()) params.set("q", query.trim());
      if (kind !== "all") params.set("kind", kind);
      if (folder) params.set("folder", folder);
      if (tag) params.set("tag", tag);
      if (trash) params.set("trash", "true");
      if (favorite) params.set("favorite", "true");
      if (unused) params.set("unused", "true");
      if (missingAlt) params.set("missing_alt", "true");
      try {
        const response = await fetch(`/api/erp/library?${params}`, {
          cache: "no-store",
          signal,
        });
        const data = (await response.json()) as LibraryResponse;
        if (!response.ok)
          throw new Error(
            data.error || "Não foi possível carregar a biblioteca.",
          );
        setItems(data.items);
        setFolders(data.folders);
        setTags(data.tags);
        setSummary(data.summary);
        setPagination(data.pagination);
        setCanWrite(data.capabilities.canWrite);
        setSelected(new Set());
      } catch (loadError) {
        if (
          loadError instanceof DOMException &&
          loadError.name === "AbortError"
        )
          return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Não foi possível carregar a biblioteca.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [
      favorite,
      folder,
      kind,
      missingAlt,
      page,
      picker,
      query,
      sort,
      tag,
      trash,
      unused,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void load(controller.signal),
      query ? 280 : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load, query]);

  function resetPage() {
    setPage(1);
  }
  function toggleSelection(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectPage() {
    setSelected(
      selected.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id)),
    );
  }

  async function mutate(payload: Record<string, unknown>, message?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/erp/library", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(data.error || "Não foi possível alterar o arquivo.");
      setEditing(undefined);
      setMoveOpen(false);
      setDetail(undefined);
      if (message) setNotice(message);
      await load();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Não foi possível alterar o arquivo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveFolder(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/erp/library/folders", {
        method: editingFolder ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          editingFolder ? { ...payload, id: editingFolder.id } : payload,
        ),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(data.error || "Não foi possível salvar a pasta.");
      setFolderOpen(false);
      setEditingFolder(undefined);
      setNotice(editingFolder ? "Pasta atualizada." : "Pasta criada.");
      await load();
    } catch (folderError) {
      setError(
        folderError instanceof Error
          ? folderError.message
          : "Não foi possível salvar a pasta.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolder(item: MediaFolder) {
    if (
      !window.confirm(
        `Excluir a pasta “${item.name}”? Os arquivos serão movidos para Geral.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/erp/library/folders?id=${item.id}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(data.error || "Não foi possível excluir a pasta.");
      if (folder === item.name) setFolder("");
      setFolderOpen(false);
      setEditingFolder(undefined);
      setNotice("Pasta excluída e arquivos movidos para Geral.");
      await load();
    } catch (folderError) {
      setError(
        folderError instanceof Error
          ? folderError.message
          : "Não foi possível excluir a pasta.",
      );
    } finally {
      setBusy(false);
    }
  }

  const content = (
    <div className={`${styles.library} ${picker ? styles.picker : ""}`}>
      <header className={styles.hero}>
        <div>
          <span>CENTRAL DOCUMENTAL</span>
          <h2>{picker ? "Selecionar mídia" : "Biblioteca inteligente"}</h2>
          <p>
            {picker
              ? "Encontre ou envie o arquivo certo sem sair do fluxo atual."
              : "Organize ativos, acompanhe uso e qualidade, preserve versões e reduza duplicidades."}
          </p>
        </div>
        <div className={styles.heroActions}>
          {picker && (
            <button type="button" onClick={onClose}>
              Fechar
            </button>
          )}
          {!picker && canWrite && (
            <button
              type="button"
              onClick={() => {
                setEditingFolder(undefined);
                setFolderOpen(true);
              }}
            >
              + Nova pasta
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => setUploadOpen(true)}
            >
              ↑ Enviar arquivos
            </button>
          )}
        </div>
      </header>

      {!picker && (
        <LibrarySummary
          summary={summary}
          setFavorite={() => {
            setFavorite(true);
            setTrash(false);
            setMissingAlt(false);
            resetPage();
          }}
          setUnused={() => {
            setUnused(true);
            setTrash(false);
            setMissingAlt(false);
            resetPage();
          }}
          setMissingAlt={() => {
            setKind("image");
            setUnused(false);
            setFavorite(false);
            setTrash(false);
            setMissingAlt(true);
            resetPage();
          }}
        />
      )}

      <section className={styles.folderRail} aria-label="Pastas da biblioteca">
        <FolderButton
          name="Todos os arquivos"
          count={summary.total}
          color="#173a55"
          active={!folder}
          onClick={() => {
            setFolder("");
            resetPage();
          }}
        />
        {folders.map((item) => (
          <div
            className={`${styles.folderItem} ${folder === item.name ? styles.active : ""}`}
            key={item.id}
          >
            <FolderButton
              name={item.name}
              count={item.count}
              color={item.color}
              active={folder === item.name}
              onClick={() => {
                setFolder(item.name);
                resetPage();
              }}
            />
            {!picker && canWrite && (
              <button
                type="button"
                className={styles.folderMenu}
                onClick={() => {
                  setEditingFolder(item);
                  setFolderOpen(true);
                }}
                aria-label={`Configurar pasta ${item.name}`}
              >
                •••
              </button>
            )}
          </div>
        ))}
      </section>

      <section className={styles.toolbar} aria-label="Filtros da biblioteca">
        <label className={styles.search}>
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPage();
            }}
            placeholder="Buscar nome, descrição ou texto alternativo"
            aria-label="Buscar arquivos"
          />
        </label>
        <select
          aria-label="Tipo de arquivo"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            resetPage();
          }}
          disabled={acceptKind !== "all"}
        >
          <option value="all">Todos os tipos</option>
          <option value="image">Imagens</option>
          <option value="video">Vídeos</option>
          <option value="document">Documentos</option>
        </select>
        <select
          aria-label="Ordenação"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            resetPage();
          }}
        >
          <option value="recent">Mais recentes</option>
          <option value="updated">Atualizados</option>
          <option value="name">Nome A–Z</option>
          <option value="size">Maior tamanho</option>
        </select>
        {!picker && (
          <>
            <button
              type="button"
              aria-pressed={favorite}
              className={favorite ? styles.filterActive : ""}
              onClick={() => {
                setFavorite((value) => !value);
                resetPage();
              }}
            >
              ★ Favoritos
            </button>
            <button
              type="button"
              aria-pressed={unused}
              className={unused ? styles.filterActive : ""}
              onClick={() => {
                setUnused((value) => !value);
                resetPage();
              }}
            >
              Sem uso
            </button>
            <button
              type="button"
              aria-pressed={missingAlt}
              className={missingAlt ? styles.filterActive : ""}
              onClick={() => {
                setMissingAlt((value) => !value);
                setKind("image");
                resetPage();
              }}
            >
              Sem texto alternativo
            </button>
            <button
              type="button"
              aria-pressed={trash}
              className={trash ? styles.filterDanger : ""}
              onClick={() => {
                setTrash((value) => !value);
                setFavorite(false);
                setUnused(false);
                setMissingAlt(false);
                resetPage();
              }}
            >
              {trash ? "Sair da lixeira" : `Lixeira (${summary.trash})`}
            </button>
          </>
        )}
        <div className={styles.viewSwitch} aria-label="Modo de visualização">
          <button
            type="button"
            aria-label="Exibir em grade"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            ▦
          </button>
          <button
            type="button"
            aria-label="Exibir em lista"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            ☷
          </button>
        </div>
      </section>

      {tags.length > 0 && (
        <nav className={styles.tags} aria-label="Filtrar por etiqueta">
          <button
            type="button"
            className={!tag ? styles.activeTag : ""}
            onClick={() => {
              setTag("");
              resetPage();
            }}
          >
            Todas as etiquetas
          </button>
          {tags.slice(0, picker ? 8 : 14).map((item) => (
            <button
              type="button"
              className={tag === item.name ? styles.activeTag : ""}
              key={item.name}
              onClick={() => {
                setTag(tag === item.name ? "" : item.name);
                resetPage();
              }}
            >
              #{item.name} <span>{item.count}</span>
            </button>
          ))}
        </nav>
      )}

      {notice && (
        <div className={styles.notice} role="status">
          ✓ {notice}
          <button
            type="button"
            onClick={() => setNotice("")}
            aria-label="Dispensar aviso"
          >
            ×
          </button>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            Tentar novamente
          </button>
        </div>
      )}

      {!picker && canWrite && items.length > 0 && (
        <div className={styles.selectionHeader}>
          <label>
            <input
              type="checkbox"
              checked={selected.size === items.length}
              onChange={selectPage}
            />{" "}
            Selecionar página
          </label>
          <span>{pagination.total} resultado(s)</span>
        </div>
      )}
      {!picker && selected.size > 0 && (
        <div
          className={styles.bulkBar}
          role="toolbar"
          aria-label="Ações em lote"
        >
          <strong>{selected.size} selecionado(s)</strong>
          <button type="button" onClick={() => setMoveOpen(true)}>
            Mover para pasta
          </button>
          {trash ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate(
                  { action: "bulk.restore", ids: Array.from(selected) },
                  "Arquivos restaurados.",
                )
              }
            >
              Restaurar
            </button>
          ) : (
            <button
              type="button"
              className={styles.dangerText}
              disabled={busy}
              onClick={() =>
                void mutate(
                  { action: "bulk.delete", ids: Array.from(selected) },
                  "Arquivos enviados para a lixeira.",
                )
              }
            >
              Enviar à lixeira
            </button>
          )}
          <button type="button" onClick={() => setSelected(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}

      {loading ? (
        <LoadingGrid />
      ) : items.length ? (
        <section
          className={`${styles.assetGrid} ${view === "list" ? styles.list : ""}`}
          aria-label="Arquivos"
        >
          {items.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              picker={picker}
              canWrite={canWrite}
              trash={trash}
              selected={selected.has(asset.id)}
              busy={busy}
              onSelect={() => onSelect?.(asset)}
              onToggle={() => toggleSelection(asset.id)}
              onDetail={() => setDetail(asset)}
              onEdit={() => setEditing(asset)}
              onFavorite={() =>
                void mutate({
                  id: asset.id,
                  action: "favorite",
                  favorite: !asset.favorite,
                })
              }
              onDelete={() =>
                void mutate(
                  { id: asset.id, action: "delete" },
                  "Arquivo enviado para a lixeira.",
                )
              }
              onRestore={() =>
                void mutate(
                  { id: asset.id, action: "restore" },
                  "Arquivo restaurado.",
                )
              }
              onPurge={() => {
                if (
                  window.confirm(
                    `Excluir “${asset.name}” definitivamente? Esta ação não pode ser desfeita.`,
                  )
                )
                  void mutate(
                    { id: asset.id, action: "purge" },
                    "Arquivo excluído definitivamente.",
                  );
              }}
            />
          ))}
        </section>
      ) : (
        !error && (
          <EmptyState
            trash={trash}
            filtered={Boolean(
              query ||
              folder ||
              tag ||
              favorite ||
              unused ||
              missingAlt ||
              kind !== "all",
            )}
            onUpload={() => setUploadOpen(true)}
            canWrite={canWrite}
            onClear={() => {
              setQuery("");
              setFolder("");
              setTag("");
              setFavorite(false);
              setUnused(false);
              setMissingAlt(false);
              setTrash(false);
              setKind(acceptKind);
              resetPage();
            }}
          />
        )
      )}

      {!loading && pagination.pages > 1 && (
        <nav className={styles.pagination} aria-label="Paginação">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            ← Anterior
          </button>
          <span>
            Página <strong>{pagination.page}</strong> de {pagination.pages} ·{" "}
            {pagination.total} arquivos
          </span>
          <button
            type="button"
            disabled={page >= pagination.pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Próxima →
          </button>
        </nav>
      )}

      {uploadOpen && canWrite && (
        <MediaUploadModal
          folders={folders}
          initialFolder={folder || "Geral"}
          acceptKind={acceptKind}
          close={() => setUploadOpen(false)}
          complete={async (result) => {
            setUploadOpen(false);
            setNotice(result);
            await load();
          }}
        />
      )}
      {editing && (
        <MediaEditModal
          asset={editing}
          folders={folders}
          close={() => setEditing(undefined)}
          submit={(payload) =>
            void mutate(
              { ...payload, id: editing.id, action: "update" },
              "Metadados atualizados.",
            )
          }
          busy={busy}
        />
      )}
      {folderOpen && (
        <FolderModal
          item={editingFolder}
          busy={busy}
          close={() => {
            setFolderOpen(false);
            setEditingFolder(undefined);
          }}
          submit={(payload) => void saveFolder(payload)}
          remove={
            editingFolder && !editingFolder.system
              ? () => void deleteFolder(editingFolder)
              : undefined
          }
        />
      )}
      {detail && (
        <DetailModal
          asset={detail}
          canWrite={canWrite}
          close={() => setDetail(undefined)}
          refresh={async (message) => {
            setNotice(message);
            setDetail(undefined);
            await load();
          }}
        />
      )}
      {moveOpen && (
        <MoveModal
          folders={folders}
          count={selected.size}
          busy={busy}
          close={() => setMoveOpen(false)}
          move={(target) =>
            void mutate(
              {
                action: "bulk.move",
                ids: Array.from(selected),
                folder: target,
              },
              "Arquivos movidos.",
            )
          }
        />
      )}
    </div>
  );
  return picker ? (
    <ModalPortal className={styles.pickerLayer} close={onClose}>
      {content}
    </ModalPortal>
  ) : (
    content
  );
}

function LibrarySummary({
  summary,
  setFavorite,
  setUnused,
  setMissingAlt,
}: {
  summary: Summary;
  setFavorite: () => void;
  setUnused: () => void;
  setMissingAlt: () => void;
}) {
  const quota = Math.min(
    (summary.sizeBytes / Math.max(summary.quotaBytes, 1)) * 100,
    100,
  );
  return (
    <section className={styles.summary} aria-label="Resumo da biblioteca">
      <article>
        <span className={styles.kpiIcon}>▦</span>
        <div>
          <small>Arquivos ativos</small>
          <strong>{summary.total}</strong>
          <p>
            {summary.images} imagens · {summary.documents} docs ·{" "}
            {summary.videos} vídeos
          </p>
        </div>
      </article>
      <article>
        <span className={styles.kpiIcon}>◴</span>
        <div>
          <small>Armazenamento</small>
          <strong>{formatBytes(summary.sizeBytes)}</strong>
          <p>
            {quota.toFixed(1)}% de {formatBytes(summary.quotaBytes)}
          </p>
          <i>
            <b style={{ width: `${Math.max(quota, 1)}%` }} />
          </i>
        </div>
      </article>
      <button type="button" onClick={setUnused}>
        <span className={styles.kpiIcon}>◎</span>
        <div>
          <small>Oportunidade de limpeza</small>
          <strong>{summary.unused}</strong>
          <p>arquivos sem nenhum vínculo</p>
        </div>
      </button>
      <button type="button" onClick={setFavorite}>
        <span className={styles.kpiIcon}>★</span>
        <div>
          <small>Seus favoritos</small>
          <strong>{summary.favorites}</strong>
          <p>acesso rápido pessoal</p>
        </div>
      </button>
      <button
        type="button"
        className={summary.missingAlt ? styles.attention : ""}
        onClick={setMissingAlt}
      >
        <span className={styles.kpiIcon}>A</span>
        <div>
          <small>Qualidade e SEO</small>
          <strong>{summary.missingAlt}</strong>
          <p>imagens sem texto alternativo</p>
        </div>
      </button>
    </section>
  );
}

function FolderButton({
  name,
  count,
  color,
  active,
  onClick,
}: {
  name: string;
  count: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.folderButton} ${active ? styles.active : ""}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <i style={{ background: color }}>
        <ErpIcon name="library" />
      </i>
      <span>
        <strong>{name}</strong>
        <small>{count} arquivo(s)</small>
      </span>
    </button>
  );
}

function AssetCard({
  asset,
  picker,
  canWrite,
  trash,
  selected,
  busy,
  onSelect,
  onToggle,
  onDetail,
  onEdit,
  onFavorite,
  onDelete,
  onRestore,
  onPurge,
}: {
  asset: MediaAsset;
  picker: boolean;
  canWrite: boolean;
  trash: boolean;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDetail: () => void;
  onEdit: () => void;
  onFavorite: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <article
      className={`${styles.assetCard} ${selected ? styles.selected : ""}`}
    >
      {!picker && canWrite && (
        <label className={styles.assetCheck}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Selecionar ${asset.name}`}
          />
        </label>
      )}
      {!picker && canWrite && !trash && (
        <button
          type="button"
          className={`${styles.favorite} ${asset.favorite ? styles.isFavorite : ""}`}
          onClick={onFavorite}
          aria-label={
            asset.favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"
          }
          aria-pressed={asset.favorite}
        >
          ★
        </button>
      )}
      <button
        type="button"
        className={styles.preview}
        onClick={picker ? onSelect : onDetail}
        aria-label={`${picker ? "Selecionar" : "Ver detalhes de"} ${asset.name}`}
      >
        {asset.kind === "image" ? (
          <img src={asset.url} alt={asset.altText || ""} loading="lazy" />
        ) : asset.kind === "video" ? (
          <>
            <video src={asset.url} muted preload="metadata" />
            <span className={styles.play}>▶</span>
          </>
        ) : (
          <span className={styles.document}>
            <b>{fileExtension(asset.originalName)}</b>
            <small>Documento</small>
          </span>
        )}
        <span className={styles.typeBadge}>{kindLabel(asset.kind)}</span>
      </button>
      <div className={styles.assetInfo}>
        <div className={styles.assetTitle}>
          <strong title={asset.name}>{asset.name}</strong>
          <span>v{asset.version}</span>
        </div>
        <p>{asset.description || asset.originalName}</p>
        <div className={styles.meta}>
          <span>{asset.folder}</span>
          <span>{formatBytes(asset.sizeBytes)}</span>
          <span className={asset.usageCount ? styles.inUse : styles.unused}>
            {asset.usageCount ? `${asset.usageCount} vínculo(s)` : "Sem uso"}
          </span>
          {asset.duplicateCount > 0 && (
            <span className={styles.duplicate}>
              {asset.duplicateCount} cópia(s)
            </span>
          )}
          {asset.expiresAt && (
            <span className={styles.expires}>
              Expira{" "}
              {tenantDateTimeFormatter().format(
                new Date(asset.expiresAt),
              )}
            </span>
          )}
        </div>
        {asset.tags.length > 0 && (
          <div className={styles.cardTags}>
            {asset.tags.slice(0, 3).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
        <small>
          Atualizado {relativeDate(asset.updatedAt)} por {asset.uploadedByName}
        </small>
      </div>
      <footer className={styles.cardActions}>
        {picker ? (
          <button type="button" className={styles.primary} onClick={onSelect}>
            Selecionar
          </button>
        ) : trash && canWrite ? (
          <>
            <button type="button" disabled={busy} onClick={onRestore}>
              Restaurar
            </button>
            <button
              type="button"
              className={styles.dangerText}
              disabled={busy || asset.usageCount > 0}
              title={
                asset.usageCount ? "Arquivo em uso" : "Excluir definitivamente"
              }
              onClick={onPurge}
            >
              Excluir
            </button>
          </>
        ) : canWrite ? (
          <>
            <button type="button" onClick={onDetail}>
              Detalhes
            </button>
            <button type="button" onClick={onEdit}>
              Editar
            </button>
            <a href={asset.url} target="_blank" rel="noreferrer">
              Abrir
            </a>
            <button
              type="button"
              className={styles.dangerText}
              disabled={busy || asset.usageCount > 0}
              title={
                asset.usageCount
                  ? "Remova os vínculos antes"
                  : "Enviar à lixeira"
              }
              onClick={onDelete}
            >
              Lixeira
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onDetail}>
              Detalhes
            </button>
            <a href={asset.url} target="_blank" rel="noreferrer">
              Abrir
            </a>
          </>
        )}
      </footer>
    </article>
  );
}

export function MediaPicker({
  value,
  acceptKind = "image",
  onChange,
  label = "Mídia",
}: {
  value?: MediaAsset | null;
  acceptKind?: "image" | "document" | "video" | "all";
  onChange: (asset: MediaAsset | null) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="media-picker-field">
      <span>{label}</span>
      {value ? (
        <div>
          {value.kind === "image" ? (
            <img src={value.url} alt={value.altText || value.name} />
          ) : (
            <b>
              {value.kind === "video"
                ? "VÍDEO"
                : fileExtension(value.originalName)}
            </b>
          )}
          <span>
            <strong>{value.name}</strong>
            <small>{formatBytes(value.sizeBytes)}</small>
          </span>
          <button type="button" onClick={() => setOpen(true)}>
            Trocar
          </button>
          <button type="button" onClick={() => onChange(null)}>
            Remover
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Escolher da biblioteca
        </button>
      )}
      {open && (
        <MediaLibrary
          picker
          acceptKind={acceptKind}
          onClose={() => setOpen(false)}
          onSelect={(asset) => {
            onChange(asset);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MediaUploadModal({
  folders,
  initialFolder,
  acceptKind,
  close,
  complete,
}: {
  folders: MediaFolder[];
  initialFolder: string;
  acceptKind: "all" | "image" | "document" | "video";
  close: () => void;
  complete: (message: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length) return setError("Selecione ao menos um arquivo.");
    setBusy(true);
    setError("");
    setProgress(0);
    const values = new FormData(event.currentTarget);
    let deduplicated = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const body = new FormData();
      body.set("file", file);
      body.set("folder", String(values.get("folder") || "Geral"));
      body.set("tags", String(values.get("tags") || ""));
      body.set("description", String(values.get("description") || ""));
      if (files.length === 1) {
        body.set("name", String(values.get("name") || file.name));
        body.set("altText", String(values.get("altText") || ""));
      }
      const response = await fetch("/api/erp/library", {
        method: "POST",
        body,
      });
      const data = (await response.json()) as {
        error?: string;
        deduplicated?: boolean;
      };
      if (!response.ok) {
        setBusy(false);
        return setError(`${file.name}: ${data.error || "falha no upload"}`);
      }
      if (data.deduplicated) deduplicated += 1;
      setProgress(Math.round(((index + 1) / files.length) * 100));
    }
    setBusy(false);
    await complete(
      deduplicated
        ? `${files.length - deduplicated} arquivo(s) enviado(s); ${deduplicated} duplicado(s) reutilizado(s).`
        : `${files.length} arquivo(s) enviado(s) com sucesso.`,
    );
  }
  function receive(list: FileList | null) {
    const next = Array.from(list || []).slice(0, 20);
    setFiles(next);
    setDragging(false);
    setError(
      (list?.length || 0) > 20
        ? "Você pode enviar até 20 arquivos por vez."
        : "",
    );
  }
  const accept =
    acceptKind === "image"
      ? "image/jpeg,image/png,image/webp,image/gif,image/avif"
      : acceptKind === "video"
        ? "video/mp4,video/webm,.m4v"
        : acceptKind === "document"
          ? ".pdf,.txt,.csv,.docx,.xlsx"
          : "image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,.m4v,.pdf,.txt,.csv,.docx,.xlsx";
  return (
    <ModalPortal close={close} className={styles.modalLayer}>
      <form onSubmit={submit} className={styles.modalCard}>
        <ModalHeader
          eyebrow="UPLOAD SEGURO"
          title="Enviar arquivos"
          description="Validação de conteúdo, deduplicação automática e isolamento por organização."
          close={close}
        />
        <button
          className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            receive(event.dataTransfer.files);
          }}
        >
          <ErpIcon name="library" />
          <strong>
            {files.length
              ? `${files.length} arquivo(s) selecionado(s)`
              : "Arraste arquivos aqui ou clique para escolher"}
          </strong>
          <small>
            Imagens e documentos até 20 MB · vídeos até 100 MB · máximo de 20
            itens
          </small>
        </button>
        <input
          ref={input}
          className={styles.fileInput}
          type="file"
          multiple
          accept={accept}
          onChange={(event) => receive(event.target.files)}
        />
        <div className={styles.formGrid}>
          <label>
            Pasta
            <select name="folder" defaultValue={initialFolder}>
              {folders.map((item) => (
                <option value={item.name} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Etiquetas
            <input
              name="tags"
              maxLength={250}
              placeholder="campanha, catálogo, 2026"
            />
          </label>
          {files.length === 1 && (
            <>
              <label>
                Nome de exibição
                <input
                  name="name"
                  defaultValue={files[0].name}
                  maxLength={200}
                />
              </label>
              <label>
                Texto alternativo
                <input
                  name="altText"
                  maxLength={300}
                  placeholder="Descreva o conteúdo visual"
                />
              </label>
            </>
          )}
          <label className={styles.wide}>
            Descrição
            <textarea
              name="description"
              maxLength={600}
              placeholder="Contexto, finalidade ou orientações de uso"
            />
          </label>
        </div>
        {files.length > 0 && (
          <div className={styles.uploadList}>
            {files.map((file) => (
              <span key={`${file.name}-${file.size}-${file.lastModified}`}>
                <b>{file.name}</b>
                <small>{formatBytes(file.size)}</small>
              </span>
            ))}
          </div>
        )}
        {busy && (
          <div className={styles.progress}>
            <span style={{ width: `${progress}%` }} />
            <small>{progress}% concluído</small>
          </div>
        )}
        {error && <div className={styles.inlineError}>{error}</div>}
        <ModalFooter
          close={close}
          busy={busy}
          action={busy ? "Enviando…" : "Enviar arquivos"}
        />
      </form>
    </ModalPortal>
  );
}

function MediaEditModal({
  asset,
  folders,
  close,
  submit,
  busy,
}: {
  asset: MediaAsset;
  folders: MediaFolder[];
  close: () => void;
  submit: (payload: Record<string, unknown>) => void;
  busy: boolean;
}) {
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <ModalPortal close={close} className={styles.modalLayer}>
      <form onSubmit={save} className={styles.modalCard}>
        <ModalHeader
          eyebrow="GOVERNANÇA DO ARQUIVO"
          title="Editar metadados"
          description="Metadados completos melhoram busca, acessibilidade e reutilização."
          close={close}
        />
        <div className={styles.formGrid}>
          <label>
            Nome
            <input
              name="name"
              defaultValue={asset.name}
              required
              maxLength={200}
            />
          </label>
          <label>
            Pasta
            <select name="folder" defaultValue={asset.folder}>
              {folders.map((item) => (
                <option value={item.name} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.wide}>
            Descrição
            <textarea
              name="description"
              defaultValue={asset.description || ""}
              maxLength={600}
            />
          </label>
          <label className={styles.wide}>
            Etiquetas
            <input
              name="tags"
              defaultValue={asset.tags.join(", ")}
              maxLength={250}
              placeholder="campanha, catálogo, 2026"
            />
          </label>
          {asset.kind === "image" && (
            <label className={styles.wide}>
              Texto alternativo
              <input
                name="altText"
                defaultValue={asset.altText}
                maxLength={300}
                placeholder="Descreva objetivamente o conteúdo da imagem"
              />
            </label>
          )}
          <label>
            Expirar em
            <input
              name="expiresAt"
              type="date"
              defaultValue={asset.expiresAt?.slice(0, 10) || ""}
            />
          </label>
          <div className={styles.readonlyField}>
            <span>Arquivo original</span>
            <strong>{asset.originalName}</strong>
            <small>
              {formatBytes(asset.sizeBytes)} · versão {asset.version}
            </small>
          </div>
        </div>
        <ModalFooter close={close} busy={busy} action="Salvar alterações" />
      </form>
    </ModalPortal>
  );
}

function FolderModal({
  item,
  busy,
  close,
  submit,
  remove,
}: {
  item?: MediaFolder;
  busy: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => void;
  remove?: () => void;
}) {
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(Object.fromEntries(new FormData(event.currentTarget)));
  }
  return (
    <ModalPortal close={close} className={styles.modalLayer}>
      <form onSubmit={save} className={styles.modalCard}>
        <ModalHeader
          eyebrow="ORGANIZAÇÃO"
          title={item ? "Configurar pasta" : "Nova pasta"}
          description="Use uma nomenclatura curta e reconhecível por toda a equipe."
          close={close}
        />
        <div className={styles.formGrid}>
          <label>
            Nome
            <input
              name="name"
              defaultValue={item?.name || ""}
              disabled={item?.system}
              required
              maxLength={60}
            />
          </label>
          <label>
            Cor
            <input
              name="color"
              type="color"
              defaultValue={item?.color || "#168151"}
            />
          </label>
          {item?.system && (
            <div className={`${styles.folderNote} ${styles.wide}`}>
              Esta pasta é protegida pelo sistema. Você pode alterar a cor, mas
              não o nome ou a exclusão.
            </div>
          )}
        </div>
        <footer className={styles.modalFooter}>
          {remove && (
            <button
              type="button"
              className={styles.dangerText}
              onClick={remove}
            >
              Excluir pasta
            </button>
          )}
          <span />
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function MoveModal({
  folders,
  count,
  busy,
  close,
  move,
}: {
  folders: MediaFolder[];
  count: number;
  busy: boolean;
  close: () => void;
  move: (folder: string) => void;
}) {
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    move(String(new FormData(event.currentTarget).get("folder") || "Geral"));
  }
  return (
    <ModalPortal close={close} className={styles.modalLayer}>
      <form onSubmit={save} className={styles.smallModal}>
        <ModalHeader
          eyebrow="AÇÃO EM LOTE"
          title={`Mover ${count} arquivo(s)`}
          description="Os vínculos existentes serão preservados."
          close={close}
        />
        <label>
          Pasta de destino
          <select name="folder">
            {folders.map((item) => (
              <option value={item.name} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <ModalFooter close={close} busy={busy} action="Mover arquivos" />
      </form>
    </ModalPortal>
  );
}

function DetailModal({
  asset,
  canWrite,
  close,
  refresh,
}: {
  asset: MediaAsset;
  canWrite: boolean;
  close: () => void;
  refresh: (message: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/erp/library/${asset.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as Detail & { error?: string };
        if (!response.ok)
          throw new Error(
            data.error || "Não foi possível carregar os detalhes.",
          );
        setDetail(data);
      } catch (detailError) {
        if (!(
          detailError instanceof DOMException &&
          detailError.name === "AbortError"
        ))
          setError(
            detailError instanceof Error
              ? detailError.message
              : "Não foi possível carregar os detalhes.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [asset.id]);
  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch(`/api/erp/library/${asset.id}/versions`, {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    const data = (await response.json()) as { error?: string };
    setBusy(false);
    if (!response.ok)
      return setError(data.error || "Não foi possível criar a versão.");
    await refresh("Nova versão publicada e histórico preservado.");
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${asset.url}`,
      );
      setCopied(true);
    } catch {
      setError("O navegador não permitiu copiar o link.");
    }
  }
  return (
    <ModalPortal close={close} className={styles.detailLayer}>
      <section className={styles.detailCard}>
        <ModalHeader
          eyebrow={`${kindLabel(asset.kind)} · VERSÃO ${asset.version}`}
          title={asset.name}
          description={asset.description || "Sem descrição cadastrada."}
          close={close}
        />
        <div className={styles.detailLayout}>
          <div className={styles.detailPreview}>
            {asset.kind === "image" ? (
              <img src={asset.url} alt={asset.altText || asset.name} />
            ) : asset.kind === "video" ? (
              <video src={asset.url} controls preload="metadata" />
            ) : asset.mimeType === "application/pdf" ? (
              <iframe src={asset.url} title={`Visualização de ${asset.name}`} />
            ) : (
              <div className={styles.documentLarge}>
                <b>{fileExtension(asset.originalName)}</b>
                <span>Pré-visualização não disponível</span>
                <a href={asset.url} target="_blank" rel="noreferrer">
                  Baixar documento
                </a>
              </div>
            )}
          </div>
          <aside className={styles.detailMeta}>
            <div>
              <small>Pasta</small>
              <strong>{asset.folder}</strong>
            </div>
            <div>
              <small>Tamanho</small>
              <strong>{formatBytes(asset.sizeBytes)}</strong>
            </div>
            <div>
              <small>Tipo</small>
              <strong>{asset.mimeType}</strong>
            </div>
            <div>
              <small>Atualização</small>
              <strong>{formatDate(asset.updatedAt)}</strong>
            </div>
            <div>
              <small>Responsável</small>
              <strong>{asset.uploadedByName}</strong>
            </div>
            <div>
              <small>Origem</small>
              <strong>{sourceLabel(asset.source)}</strong>
            </div>
            {asset.expiresAt && (
              <div>
                <small>Expiração</small>
                <strong>{formatDate(asset.expiresAt)}</strong>
              </div>
            )}
            <div className={styles.detailButtons}>
              <a href={asset.url} target="_blank" rel="noreferrer">
                Abrir original
              </a>
              <button type="button" onClick={() => void copyLink()}>
                {copied ? "Link copiado" : "Copiar link interno"}
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setReplacing((value) => !value)}
                >
                  Nova versão
                </button>
              )}
            </div>
          </aside>
        </div>
        {asset.tags.length > 0 && (
          <div className={styles.detailTags}>
            {asset.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
        {replacing && (
          <form className={styles.replaceForm} onSubmit={replace}>
            <label>
              Novo arquivo
              <input name="file" type="file" required />
            </label>
            <label>
              Nota da versão
              <input
                name="changeNote"
                required
                maxLength={300}
                placeholder="O que mudou nesta versão?"
              />
            </label>
            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? "Publicando…" : "Publicar versão"}
            </button>
          </form>
        )}
        {error && <div className={styles.inlineError}>{error}</div>}
        {loading ? (
          <p className={styles.detailLoading}>Carregando histórico…</p>
        ) : (
          detail && (
            <div className={styles.detailSections}>
              <section>
                <h3>Onde está em uso</h3>
                {detail.usage.length ? (
                  <ul>
                    {detail.usage.map((item) => (
                      <li key={item.key}>
                        <span>{item.label}</span>
                        <strong>{item.count}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    Nenhum vínculo ativo. Este arquivo pode ser removido com
                    segurança.
                  </p>
                )}
              </section>
              <section>
                <h3>Histórico de versões</h3>
                <ul>
                  {detail.versions.map((version) => (
                    <li key={version.id ?? "current"}>
                      <span>
                        <strong>
                          v{version.version} {version.current && <em>Atual</em>}
                        </strong>
                        <small>
                          {version.changeNote || version.originalName} ·{" "}
                          {formatDate(version.createdAt)}
                        </small>
                      </span>
                      <a href={version.url} target="_blank" rel="noreferrer">
                        Abrir
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>Trilha de auditoria</h3>
                <ul>
                  {detail.audit.length ? (
                    detail.audit.slice(0, 8).map((event) => (
                      <li key={event.id}>
                        <span>
                          <strong>{auditLabel(event.action)}</strong>
                          <small>{formatDate(event.createdAt)}</small>
                        </span>
                      </li>
                    ))
                  ) : (
                    <li>Nenhum evento adicional.</li>
                  )}
                </ul>
              </section>
            </div>
          )
        )}
      </section>
    </ModalPortal>
  );
}

function EmptyState({
  trash,
  filtered,
  onUpload,
  onClear,
  canWrite,
}: {
  trash: boolean;
  filtered: boolean;
  onUpload: () => void;
  onClear: () => void;
  canWrite: boolean;
}) {
  return (
    <section className={styles.empty}>
      <ErpIcon name="library" />
      <h3>
        {trash
          ? "A lixeira está vazia"
          : filtered
            ? "Nenhum arquivo combina com os filtros"
            : "Sua biblioteca começa aqui"}
      </h3>
      <p>
        {trash
          ? "Arquivos removidos aparecerão aqui para restauração ou exclusão definitiva."
          : filtered
            ? "Limpe os filtros ou tente termos mais amplos."
            : "Envie imagens, vídeos e documentos para reutilizar em todo o ERP."}
      </p>
      {filtered || trash ? (
        <button type="button" onClick={onClear}>
          Limpar filtros
        </button>
      ) : canWrite ? (
        <button type="button" className={styles.primary} onClick={onUpload}>
          Enviar primeiro arquivo
        </button>
      ) : null}
    </section>
  );
}
function LoadingGrid() {
  return (
    <section className={styles.loading} aria-label="Carregando arquivos">
      {Array.from({ length: 8 }, (_, index) => (
        <span key={index} />
      ))}
    </section>
  );
}
function ModalHeader({
  eyebrow,
  title,
  description,
  close,
}: {
  eyebrow: string;
  title: string;
  description: string;
  close: () => void;
}) {
  return (
    <header className={styles.modalHeader}>
      <div>
        <small>{eyebrow}</small>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <button type="button" onClick={close} aria-label="Fechar">
        ×
      </button>
    </header>
  );
}
function ModalFooter({
  close,
  busy,
  action,
}: {
  close: () => void;
  busy: boolean;
  action: string;
}) {
  return (
    <footer className={styles.modalFooter}>
      <span />
      <button type="button" onClick={close}>
        Cancelar
      </button>
      <button type="submit" className={styles.primary} disabled={busy}>
        {action}
      </button>
    </footer>
  );
}
function ModalPortal({
  children,
  close,
  className = "",
}: {
  children: ReactNode;
  close?: () => void;
  className?: string;
}) {
  return (
    <ErpModal
      className={className}
      close={() => close?.()}
      label="Biblioteca de mídias"
    >
      {children}
    </ErpModal>
  );
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function fileExtension(name: string) {
  return name.split(".").pop()?.toUpperCase().slice(0, 5) || "DOC";
}
function formatDate(value: string) {
  return tenantDateTimeFormatter({ dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
function relativeDate(value: string) {
  const days = Math.floor(
    (Date.now() - new Date(value).getTime()) / 86_400_000,
  );
  return days <= 0 ? "hoje" : days === 1 ? "ontem" : `há ${days} dias`;
}
function kindLabel(kind: MediaAsset["kind"]) {
  return kind === "image" ? "Imagem" : kind === "video" ? "Vídeo" : "Documento";
}
function sourceLabel(source: string) {
  return source === "catalog"
    ? "Catálogo demonstrativo"
    : source === "integration"
      ? "Integração"
      : "Upload da equipe";
}
function auditLabel(action: string) {
  const labels: Record<string, string> = {
    "media.uploaded": "Arquivo enviado",
    "media.updated": "Metadados atualizados",
    "media.delete": "Enviado à lixeira",
    "media.restore": "Arquivo restaurado",
    "media.version_uploaded": "Nova versão publicada",
  };
  return labels[action] || action.replace("media.", "").replaceAll("_", " ");
}
