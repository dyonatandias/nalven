"use client";
import { usePlanFeatures } from "./plan-features";
/* eslint-disable @typescript-eslint/no-explicit-any, @next/next/no-img-element */

import type { FormEvent, ReactNode } from "react";
import { createContext, useContext, Children, cloneElement, isValidElement, useId, useEffect, useMemo, useState } from "react";
import { MediaPicker, type MediaAsset } from "@/components/erp/media-library";
import { validGtin } from "@/lib/erp/report-domain";
import { ErpModal } from "@/components/erp/modal-portal";

export type ProductCatalogItem = {
  id: number;
  name: string;
  sku: string;
  type: string;
  price: number;
  cost: number;
  category: string;
  stock: number;
  minStock: number;
  unit: string;
  active: boolean;
  imageMediaId?: string | null;
  [key: string]: any;
};

type Reference = { id: number; name: string; provider?: string };
type AttributeRow = {
  name: string;
  type: string;
  swatchType: string;
  scope: string;
  visible: boolean;
  variation: boolean;
  options: string;
};
type VariationRow = {
  id: number | null;
  sku: string;
  gtin: string;
  attributes: string;
  regularPrice: string;
  salePrice: string;
  saleStartsAt: string;
  saleEndsAt: string;
  manageStock: string;
  stock: string;
  stockStatus: string;
  backorders: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  image: MediaAsset | null;
  gallery: MediaAsset[];
  galleryPick: MediaAsset | null;
  videoUrl: string;
  description: string;
  enabled: boolean;
};
type DownloadRow = { name: string; url: string; media: MediaAsset | null };
type CostRow = { type: string; label: string; value: string };
type TierRow = { minimumQty: string; maximumQty: string; price: string };
type RelationRow = { type: string; relatedProductId: string };
type PairRow = { label: string; value: string };
type MarketplaceRow = {
  platform: string;
  channelId: string;
  remoteCategoryId: string;
  remoteCatalogProductId: string;
  listingType: string;
  priceOverride: string;
  stockOverride: string;
  attributes: string;
  saleTerms: string;
};

const TABS = [
  ["essencial", "Essencial"],
  ["precos", "Preços e custos"],
  ["estoque", "Estoque e logística"],
  ["fiscal", "Fiscal Brasil"],
  ["midia", "Mídia"],
  ["variacoes", "Atributos e variações"],
  ["seo", "SEO"],
  ["extras", "Relacionamentos e extras"],
  ["marketplaces", "Marketplaces"],
] as const;
const ProductErrors = createContext<Array<{ field: HTMLInputElement; message: string }>>([]);
type ProductTab = (typeof TABS)[number][0];

export function ProductCatalogForm({
  item,
  mode = item ? "edit" : "create",
  products,
  categories,
  brands,
  channels,
  busy,
  autoGenerateSku = true,
  close,
  submit,
}: {
  item?: ProductCatalogItem;
  mode?: "create" | "edit" | "view";
  products: ProductCatalogItem[];
  categories: Reference[];
  brands: Reference[];
  channels: Reference[];
  busy: boolean;
  autoGenerateSku?: boolean;
  close: () => void;
  submit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const features = usePlanFeatures();
  const readOnly = mode === "view";
  const visibleTabs = TABS.filter(([id]) => id !== "marketplaces" || features.marketplaces);
  const [issues, setIssues] = useState<Array<{ field: HTMLInputElement; message: string; tab: string }>>([]);
  const [tab, setTab] = useState<ProductTab>(TABS[0][0]);
  const [catalogType, setCatalogType] = useState(item?.catalogType || "simple");
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState("");
  const [primaryImage, setPrimaryImage] = useState<MediaAsset | null>(() =>
    mediaFrom(item?.imageMedia),
  );
  const [ogImage, setOgImage] = useState<MediaAsset | null>(() =>
    mediaFrom(item?.seoOgImageMedia),
  );
  const [videoMedia, setVideoMedia] = useState<MediaAsset | null>(() =>
    mediaFrom(item?.videoMedia),
  );
  const [videoThumb, setVideoThumb] = useState<MediaAsset | null>(() =>
    mediaFrom(item?.videoThumbnailMedia),
  );
  const [gallery, setGallery] = useState<MediaAsset[]>(
    () =>
      (item?.gallery || [])
        .map((row: any) => mediaFrom(row.mediaAsset))
        .filter(Boolean) as MediaAsset[],
  );
  const [galleryPick, setGalleryPick] = useState<MediaAsset | null>(null);
  const [attributes, setAttributes] = useState<AttributeRow[]>(() =>
    (item?.attributes || []).map((row: any) => ({
      name: row.name,
      type: row.type,
      swatchType: row.swatchType || "select",
      scope: row.scope,
      visible: row.visible,
      variation: row.variation,
      options: (row.options || [])
        .map((option: any) =>
          option.color ? `${option.name}|${option.color}` : option.name,
        )
        .join(", "),
    })),
  );
  const [variations, setVariations] = useState<VariationRow[]>(() =>
    (item?.variations || []).map((row: any) => ({
      id: Number.isInteger(row.id) ? row.id : null,
      sku: row.sku || "",
      gtin: row.gtin || "",
      attributes: pairsToText(row.attributes),
      regularPrice: value(row.regularPrice),
      salePrice: value(row.salePrice),
      saleStartsAt: dateLocal(row.saleStartsAt),
      saleEndsAt: dateLocal(row.saleEndsAt),
      manageStock: row.manageStock || "parent",
      stock: value(row.stock),
      stockStatus: row.stockStatus || "",
      backorders: row.backorders || "",
      weight: value(row.weight),
      length: value(row.length),
      width: value(row.width),
      height: value(row.height),
      image: mediaFrom(row.imageMedia),
      gallery: (row.gallery || [])
        .map((image: any) => mediaFrom(image.mediaAsset))
        .filter(Boolean),
      galleryPick: null,
      videoUrl: row.videoUrl || "",
      description: row.description || "",
      enabled: row.enabled !== false,
    })),
  );
  const [downloads, setDownloads] = useState<DownloadRow[]>(() =>
    (item?.downloads || []).map((row: any) => ({
      name: row.name,
      url: row.url || "",
      media: mediaFrom(row.mediaAsset),
    })),
  );
  const [costItems, setCostItems] = useState<CostRow[]>(() =>
    (item?.costItems || []).map((row: any) => ({
      type: row.type,
      label: row.label,
      value: value(row.value),
    })),
  );
  const [tiers, setTiers] = useState<TierRow[]>(() =>
    (item?.priceTiers || []).map((row: any) => ({
      minimumQty: value(row.minimumQty),
      maximumQty: value(row.maximumQty),
      price: value(row.price),
    })),
  );
  const [relations, setRelations] = useState<RelationRow[]>(() =>
    (item?.relatedFrom || []).map((row: any) => ({
      type: row.type,
      relatedProductId: String(row.relatedProductId),
    })),
  );
  const [badges, setBadges] = useState<PairRow[]>(() =>
    jsonArray(item?.badges).map((row: any) => ({
      label: row.label || "",
      value: row.color || "#168151",
    })),
  );
  const [customFields, setCustomFields] = useState<PairRow[]>(() =>
    jsonArray(item?.customFields).map((row: any) => ({
      label: row.label || "",
      value: row.value || "",
    })),
  );
  const [configurator, setConfigurator] = useState<
    Array<{ label: string; type: string; required: boolean; price: string }>
  >(() =>
    jsonArray(item?.configuratorData?.fields).map((row: any) => ({
      label: row.label || "",
      type: row.type || "text",
      required: Boolean(row.required),
      price: value(row.price),
    })),
  );
  const [marketplaces, setMarketplaces] = useState<MarketplaceRow[]>(() =>
    (item?.marketplaceProfiles || []).map((row: any) => ({
      platform: row.platform,
      channelId: row.channelId ? String(row.channelId) : "",
      remoteCategoryId: row.remoteCategoryId || "",
      remoteCatalogProductId: row.remoteCatalogProductId || "",
      listingType: row.listingType || "",
      priceOverride: value(row.priceOverride),
      stockOverride: value(row.stockOverride),
      attributes: pairsToText(row.attributes),
      saleTerms: pairsToText(row.saleTerms),
    })),
  );
  const initialCategoryIds = useMemo(
    () => (item?.categoryLinks || []).map((row: any) => String(row.categoryId)),
    [item],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function requestClose() {
    if (busy) return;
    if (
      !dirty ||
      window.confirm("Descartar as alterações não salvas deste item?")
    )
      close();
  }

  function openInvalidField(field: HTMLElement, message: string) {
    const fieldTab = field.closest<HTMLElement>("[data-product-tab]")?.dataset
      .productTab as ProductTab | undefined;
    if (fieldTab) setTab(fieldTab);
    setFormError(message);
    window.requestAnimationFrame(() => {
      field.focus();
      if ("reportValidity" in field)
        (field as HTMLInputElement).reportValidity();
    });
  }

  function validate(form: HTMLFormElement) {
    const fields = Array.from(form.querySelectorAll<HTMLInputElement>("input, select, textarea"));
    const result: Array<{ field: HTMLInputElement; message: string; tab: string }> = [];
    const get = (name: string) => fields.find(field => field.name === name);
    const val = (name: string) => get(name)?.value.trim() || "";
    const add = (field: HTMLInputElement | undefined, message: string) => {
      if (!field || result.some(issue => issue.field === field)) return;
      result.push({ field, message, tab: field.closest<HTMLElement>("[data-product-tab]")?.dataset.productTab || "essencial" });
    };
    for (const field of fields) {
      field.removeAttribute("aria-invalid");
      if (field.disabled || !field.willValidate) continue;
      const label = field.getAttribute("aria-label") || field.placeholder || field.name || "Campo";
      if (field.required && !field.value.trim()) add(field, `${label}: preencha este campo.`);
      else if (!field.validity.valid) add(field, `${label}: ${field.validationMessage}`);
      if (field.type === "url" && field.value && !/^https?:\/\//i.test(field.value)) add(field, `${label}: use uma URL com https:// ou http://.`);
    }
    if (!val("categoryId") && !val("category")) add(get("categoryId"), "Categoria principal: selecione uma categoria ou informe uma nova.");
    if (val("type") === "service" && !["simple", "external"].includes(val("catalogType"))) add(get("catalogType"), "Serviços devem usar catálogo simples ou externo.");
    if (val("catalogType") === "external" && !val("externalUrl")) add(get("externalUrl"), "URL externa: informe o endereço do item externo.");
    if (val("saleStartsAt") && val("saleEndsAt") && val("saleEndsAt") <= val("saleStartsAt")) add(get("saleEndsAt"), "Fim da promoção: escolha uma data posterior ao início.");
    for (const name of ["gtin", "gtinTributary"]) if (val(name) && !validGtin(val(name))) add(get(name), `${name === "gtin" ? "GTIN / EAN" : "GTIN tributário"}: confira os dígitos e o dígito verificador.`);
    for (const [name, length] of [["ncm", 8], ["cest", 7], ["spedItemType", 2]] as const) {
      if (name === "cest" && get("cestNotApplicable")?.checked) continue;
      if (val(name) && !new RegExp(`^\\d{${length}}$`).test(val(name))) add(get(name), `${name.toUpperCase()}: informe ${length} dígitos.`);
    }
    if (val("sku") && products.some(product => product.id !== (mode === "edit" ? item?.id : undefined) && product.sku === val("sku"))) add(get("sku"), "SKU: este código já está em uso no catálogo.");
    const sectionField = (tab: string, selector = "input") => form.querySelector<HTMLInputElement>(`[data-product-tab=${tab}] ${selector}`) || undefined;
    if (downloads.some(row => (row.name.trim() || row.url.trim() || row.media) && (!row.name.trim() || (!row.url.trim() && !row.media)))) add(sectionField("midia", ".product-download-row input"), "Downloads: cada arquivo precisa de nome e URL ou mídia. Complete a linha ou remova-a.");
    if (attributes.some(row => !row.name.trim() && row.options.trim())) add(sectionField("variacoes", ".product-complex-row input"), "Atributos: informe o nome do atributo cujas opções foram preenchidas.");
    if (costItems.some(row => !row.label.trim() && row.value)) add(sectionField("precos", ".product-repeat-row input"), "Custos: informe a descrição de cada componente com valor.");
    if (tiers.some(row => (row.minimumQty || row.maximumQty || row.price) && (!(Number(row.minimumQty) > 0) || !row.price || (row.maximumQty && Number(row.maximumQty) < Number(row.minimumQty))))) add(sectionField("precos", ".product-repeat-row input"), "Preços por volume: preencha quantidade mínima positiva e preço; a quantidade máxima não pode ser menor que a mínima.");
    for (const issue of result) issue.field.setAttribute("aria-invalid", "true");
    return result;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (busy || readOnly) return;
    const nextIssues = validate(event.currentTarget);
    setIssues(nextIssues);
    if (nextIssues.length) {
      openInvalidField(nextIssues[0].field, "Revise as pendências antes de salvar.");
      return;
    }
    setFormError("");
    const payload: Record<string, unknown> = Object.fromEntries(form.entries());
    const numeric = [
      "menuOrder",
      "regularPrice",
      "salePrice",
      "installmentPrice",
      "cashPrice",
      "minimumSalePrice",
      "targetMargin",
      "cost",
      "cogs",
      "stock",
      "minStock",
      "weight",
      "length",
      "width",
      "height",
      "netWeight",
      "grossWeight",
      "volumes",
      "itemsPerBox",
      "crossDockingDays",
      "downloadLimit",
      "downloadExpiryDays",
      "warrantyMonths",
      "taxBurdenRate",
      "icmsStBase",
      "icmsStValue",
      "icmsSubstituteValue",
      "pisFixedValue",
      "cofinsFixedValue",
      "seoScore",
    ];
    for (const key of numeric) payload[key] = optionalNumber(form.get(key));
    for (const key of [
      "featured",
      "active",
      "manageStock",
      "soldIndividually",
      "freeShipping",
      "virtual",
      "downloadable",
      "reviewsAllowed",
      "seoNoindex",
      "carouselEnabled",
      "carouselAutoplay",
      "cestNotApplicable",
    ])
      payload[key] = form.has(key);
    payload.id = mode === "edit" ? item?.id : undefined;
    if (mode === "edit") delete payload.stock;
    payload.categoryId = optionalNumber(form.get("categoryId"));
    payload.categoryIds = form
      .getAll("categoryIds")
      .map(Number)
      .filter(Number.isInteger);
    payload.seoSecondaryKeywords = splitList(
      String(form.get("seoSecondaryKeywords") || ""),
    );
    payload.tags = splitList(String(form.get("tags") || ""));
    payload.imageMediaId = primaryImage?.id || null;
    payload.seoOgImageMediaId = ogImage?.id || null;
    payload.videoMediaId = videoMedia?.id || null;
    payload.videoThumbnailMediaId = videoThumb?.id || null;
    payload.galleryMediaIds = gallery.map((asset) => asset.id);
    payload.attributes = attributes
      .filter((row) => row.name.trim())
      .map((row) => ({
        ...row,
        options: splitList(row.options).map((entry) => {
          const [name, swatchColor] = entry
            .split("|")
            .map((part) => part.trim());
          const previous = item?.attributes?.find((attribute: any) => attribute.name === row.name)?.options?.find((option: any) => option.name === name);
          return { name, value: previous?.value ?? name, imageMediaId: previous?.imageMediaId || undefined, color: swatchColor || undefined };
        }),
      }));
    payload.variations = variations
      .filter((row) => row.sku.trim() || row.attributes.trim())
      .map((row) => ({
        id: mode === "edit" ? row.id ?? undefined : undefined,
        sku: row.sku,
        gtin: row.gtin,
        attributes: textToPairs(row.attributes),
        regularPrice: optionalNumber(row.regularPrice),
        salePrice: optionalNumber(row.salePrice),
        saleStartsAt: row.saleStartsAt,
        saleEndsAt: row.saleEndsAt,
        manageStock: row.manageStock,
        stock: optionalNumber(row.stock),
        stockStatus: row.stockStatus,
        backorders: row.backorders,
        weight: optionalNumber(row.weight),
        length: optionalNumber(row.length),
        width: optionalNumber(row.width),
        height: optionalNumber(row.height),
        imageMediaId: row.image?.id || null,
        galleryMediaIds: row.gallery.map((asset) => asset.id),
        videoUrl: row.videoUrl,
        description: row.description,
        enabled: row.enabled,
      }));
    payload.downloads = downloads
      .filter((row) => row.name.trim() && (row.url.trim() || row.media))
      .map((row) => ({
        name: row.name,
        url: row.url,
        mediaAssetId: row.media?.id || null,
      }));
    payload.costItems = costItems
      .filter((row) => row.label.trim())
      .map((row) => ({ ...row, value: optionalNumber(row.value) || 0 }));
    payload.priceTiers = tiers
      .filter((row) => row.minimumQty)
      .map((row) => ({
        minimumQty: optionalNumber(row.minimumQty),
        maximumQty: optionalNumber(row.maximumQty),
        price: optionalNumber(row.price),
      }));
    payload.relations = relations
      .filter((row) => row.relatedProductId)
      .map((row) => ({
        type: row.type,
        relatedProductId: Number(row.relatedProductId),
      }));
    payload.badges = badges
      .filter((row) => row.label.trim())
      .map((row) => ({ label: row.label, color: row.value }));
    payload.customFields = customFields
      .filter((row) => row.label.trim())
      .map((row) => ({ label: row.label, value: row.value }));
    payload.carouselConfig = {
      enabled: form.has("carouselEnabled"),
      autoplay: form.has("carouselAutoplay"),
      interval: optionalNumber(form.get("carouselInterval")) || 5,
    };
    payload.configuratorData = {
      fields: configurator
        .filter((row) => row.label.trim())
        .map((row) => ({ ...row, price: optionalNumber(row.price) })),
    };
    payload.marketplaces = (features.marketplaces ? marketplaces : []).map((row) => ({
      ...row,
      channelId: optionalNumber(row.channelId),
      priceOverride: optionalNumber(row.priceOverride),
      stockOverride: optionalNumber(row.stockOverride),
      attributes: textToPairs(row.attributes),
      saleTerms: textToPairs(row.saleTerms),
    }));
    if (!features.marketplaces) delete payload.marketplaces;
    try {
      if (await submit(payload)) { setDirty(false); close(); }
      else setFormError("Não foi possível salvar. Seus dados foram mantidos; confira a mensagem da operação e tente novamente.");
    } catch {
      setFormError("Não foi possível salvar. Seus dados foram mantidos. Verifique a conexão e tente novamente.");
    }
  }

  const tabIndex = visibleTabs.findIndex(([id]) => id === tab);

  return (
    <ErpModal
      close={requestClose}
      className="product-catalog-modal"
      label={readOnly ? "Visualizar item" : mode === "edit" ? "Editar produto" : "Cadastrar produto"}
    >
      <form
        onSubmit={save}
        onChangeCapture={(event) => { if (!readOnly) { setDirty(true); if (issues.length) setIssues(validate(event.currentTarget)); } }}
        onClickCapture={(event) => {
          if (
            (event.target as HTMLElement).closest(
              ".product-repeater>header>button, .product-repeat-row>button, .product-complex-row button, .product-variation-row>header>button, .product-marketplace-row>header>button, .product-gallery-item button, .product-download-row>button",
            )
          )
            setDirty(true);
        }}
        className="product-catalog-card"
        noValidate
      >
        <header className="product-catalog-header">
          <div>
            <small>
              {readOnly ? "VISUALIZAR ITEM" : mode === "edit"
                ? "EDITAR ITEM"
                : item
                  ? "DUPLICAR ITEM"
                  : "NOVO ITEM"}
            </small>
            <h2>
              {mode !== "create"
                ? item?.name
                : item
                  ? `Cópia de ${item.name}`
                  : "Novo produto ou serviço"}
            </h2>
            <p>
              Dados comerciais, operacionais, fiscais e multicanal em um único
              cadastro.
            </p>
          </div>
          {dirty && (
            <span className="product-unsaved">Alterações não salvas</span>
          )}
          <button type="button" onClick={requestClose} aria-label="Fechar">
            ×
          </button>
        </header>
        <nav className="product-form-tabs" aria-label="Seções do produto">
          {visibleTabs.map(([id, label], index) => (
            <button
              id={`product-tab-${id}`}
              aria-controls={`product-panel-${id}`}
              aria-current={tab === id ? "step" : undefined}
              type="button"
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
              }}
              key={id}
            >
              <span>{index + 1}</span>
              {label}
              {issues.some(issue => issue.tab === id) && <b className="product-tab-errors" aria-label="Pendências">{issues.filter(issue => issue.tab === id).length}</b>}
            </button>
          ))}
        </nav>
        <ProductErrors.Provider value={issues}><fieldset className="product-form-body product-form-fields" disabled={readOnly || busy}>
          <p className="product-required-note">{readOnly ? "Consulta do cadastro. Campos em modo de visualização." : "Preencha os campos indicados como Obrigatório. Complete as demais seções conforme a operação."}</p>
          {issues.length > 0 && <div className="product-form-error" role="alert"><strong>{issues.length} pendência(s) para corrigir</strong><ul>{issues.map((issue, index) => <li key={index}><button type="button" onClick={() => openInvalidField(issue.field, issue.message)}>{issue.message}</button></li>)}</ul></div>}
          {formError && !issues.length && (
            <div className="product-form-error" role="alert">
              {formError}
            </div>
          )}
          {
            <Section
              tabId="essencial"
              active={tab === "essencial"}
              title="Identidade e publicação"
              note="Informações que identificam e apresentam o item no catálogo."
            >
              <Field label="Nome" wide>
                <input
                  name="name"
                  defaultValue={item?.name || ""}
                  required
                  maxLength={200}
                />
              </Field>
              <Field label="Slug / URL">
                <input
                  name="slug"
                  defaultValue={item?.slug || ""}
                  placeholder="gerado automaticamente"
                />
              </Field>
              <Field label="SKU" hint="Informe um código único quando a geração automática estiver desativada nas configurações.">
                <input name="sku" required={!autoGenerateSku} maxLength={100} defaultValue={item?.sku || ""} />
              </Field>
              <Field label="Natureza">
                <select name="type" defaultValue={item?.type || "product"}>
                  <option value="product">Produto</option>
                  {features.services && <option value="service">Serviço</option>}
                </select>
              </Field>
              <Field label="Tipo de catálogo">
                <select
                  name="catalogType"
                  value={catalogType}
                  onChange={(event) => setCatalogType(event.target.value)}
                >
                  <option value="simple">Simples</option>
                  <option value="variable">Variável</option>
                  <option value="external">Externo / afiliado</option>
                  <option value="grouped">Agrupado</option>
                </select>
              </Field>
              <Field label="Status">
                <select name="status" defaultValue={item?.status || "publish"}>
                  <option value="publish">Publicado</option>
                  <option value="draft">Rascunho</option>
                  <option value="pending">Pendente de revisão</option>
                  <option value="private">Privado</option>
                  <option value="trash">Lixeira</option>
                </select>
              </Field>
              <Field label="Visibilidade">
                <select
                  name="catalogVisibility"
                  defaultValue={item?.catalogVisibility || "visible"}
                >
                  <option value="visible">Catálogo e busca</option>
                  <option value="catalog">Somente catálogo</option>
                  <option value="search">Somente busca</option>
                  <option value="hidden">Oculto</option>
                </select>
              </Field>
              <Field label="Ordem no menu">
                <input
                  name="menuOrder"
                  type="number"
                  defaultValue={item?.menuOrder || 0}
                />
              </Field>
              <Field label="Categoria principal" required hint="Selecione uma categoria ou informe o nome de uma nova abaixo.">
                <select name="categoryId" defaultValue={item?.categoryId || ""}>
                  <option value="">Selecione ou cadastre abaixo</option>
                  {categories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <input
                  name="category"
                  aria-label="Nome de uma nova categoria"
                  defaultValue={item?.categoryId ? "" : item?.category || ""}
                  placeholder="Nome de uma nova categoria"
                />
              </Field>
              <Field label="Categorias adicionais">
                <select
                  name="categoryIds"
                  defaultValue={initialCategoryIds}
                  multiple
                >
                  {categories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Marca">
                <input
                  name="brand"
                  defaultValue={item?.brand?.name || ""}
                  list="product-brands"
                />
                <datalist id="product-brands">
                  {brands.map((brand) => (
                    <option value={brand.name} key={brand.id} />
                  ))}
                </datalist>
              </Field>
              <Field label="Modelo">
                <input name="model" defaultValue={item?.model || ""} />
              </Field>
              <Field label="MPN / código do fabricante">
                <input name="mpn" defaultValue={item?.mpn || ""} />
              </Field>
              <Field label="GTIN / EAN">
                <input
                  name="gtin"
                  defaultValue={item?.gtin || item?.barcode || ""}
                  inputMode="numeric"
                />
              </Field>
              <Field label="Código de barras interno">
                <input name="barcode" defaultValue={item?.barcode || ""} />
              </Field>
              <Field label="Gênero">
                <input
                  name="gender"
                  defaultValue={item?.gender || ""}
                  placeholder="Ex.: unissex"
                />
              </Field>
              <Field label="Fornecedor">
                <input name="supplier" defaultValue={item?.supplier || ""} />
              </Field>
              <Field label="Descrição curta" wide>
                <textarea
                  name="shortDescription"
                  defaultValue={item?.shortDescription || ""}
                  rows={3}
                />
              </Field>
              <Field label="Descrição completa" wide>
                <textarea
                  name="description"
                  defaultValue={item?.description || ""}
                  rows={8}
                />
              </Field>
              <Field label="URL externa">
                <input
                  name="externalUrl"
                  required={catalogType === "external"}
                  type="url"
                  defaultValue={item?.externalUrl || ""}
                />
              </Field>
              <Field label="Texto do botão externo">
                <input
                  name="buttonText"
                  defaultValue={item?.buttonText || ""}
                />
              </Field>
              <Checks>
                <Check
                  name="active"
                  label="Ativo"
                  checked={item?.active !== false}
                />
                <Check
                  name="featured"
                  label="Produto em destaque"
                  checked={Boolean(item?.featured)}
                />
                <Check
                  name="reviewsAllowed"
                  label="Permitir avaliações"
                  checked={item?.reviewsAllowed !== false}
                />
              </Checks>
              {item && (
                <div className="product-derived-stats wide">
                  <span>
                    <small>Vendas acumuladas</small>
                    <strong>{item.totalSales || 0}</strong>
                  </span>
                  <span>
                    <small>Avaliação média</small>
                    <strong>
                      {Number(item.averageRating || 0).toFixed(1)}
                    </strong>
                  </span>
                  <span>
                    <small>Avaliações</small>
                    <strong>{item.ratingCount || 0}</strong>
                  </span>
                  <span>
                    <small>Curtidas</small>
                    <strong>{item.likesCount || 0}</strong>
                  </span>
                </div>
              )}
              <Field label="Nota após a compra" wide>
                <textarea
                  name="purchaseNote"
                  defaultValue={item?.purchaseNote || ""}
                  rows={3}
                />
              </Field>
            </Section>
          }

          {
            <Section
              tabId="precos"
              active={tab === "precos"}
              title="Preço, custo e margem"
              note="Preço final, promoções, COGS e faixas por volume."
            >
              <Field label="Preço regular (R$)">
                <input
                  name="regularPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={item?.regularPrice ?? item?.price ?? 0}
                  required
                />
              </Field>
              <Field label="Preço promocional (R$)">
                <input
                  name="salePrice"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.salePrice)}
                />
              </Field>
              <Field label="Início da promoção">
                <input
                  name="saleStartsAt"
                  type="datetime-local"
                  defaultValue={dateLocal(item?.saleStartsAt)}
                />
              </Field>
              <Field label="Fim da promoção">
                <input
                  name="saleEndsAt"
                  type="datetime-local"
                  defaultValue={dateLocal(item?.saleEndsAt)}
                />
              </Field>
              <Field label="Preço à vista">
                <input
                  name="cashPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.cashPrice)}
                />
              </Field>
              <Field label="Valor da parcela">
                <input
                  name="installmentPrice"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.installmentPrice)}
                />
              </Field>
              <Field label="Preço mínimo">
                <input
                  name="minimumSalePrice"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.minimumSalePrice)}
                />
              </Field>
              <Field label="Margem alvo (%)">
                <input
                  name="targetMargin"
                  type="number"
                  step="0.01"
                  defaultValue={value(item?.targetMargin)}
                />
              </Field>
              <Field label="Custo base">
                <input
                  name="cost"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={item?.catalogCost ?? item?.cost ?? 0}
                />
              </Field>
              <Field label="COGS">
                <input
                  name="cogs"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.cogs)}
                />
              </Field>
              <Field label="Origem da precificação">
                <select
                  name="pricingSource"
                  defaultValue={item?.pricingSource || "auto"}
                >
                  <option value="auto">Cascata automática</option>
                  <option value="product">Produto</option>
                  <option value="category">Categoria</option>
                  <option value="global">Global</option>
                </select>
              </Field>
              <Repeater
                title="Componentes de custo"
                add={() =>
                  setCostItems((rows) => [
                    ...rows,
                    { type: "direct", label: "", value: "" },
                  ])
                }
              >
                {costItems.map((row, index) => (
                  <Row
                    key={index}
                    remove={() => setCostItems((rows) => removeAt(rows, index))}
                  >
                    <select
                      value={row.type}
                      onChange={(event) =>
                        patchRow(
                          setCostItems,
                          index,
                          "type",
                          event.target.value,
                        )
                      }
                    >
                      <option value="direct">Direto</option>
                      <option value="indirect">Indireto</option>
                    </select>
                    <input
                      value={row.label}
                      onChange={(event) =>
                        patchRow(
                          setCostItems,
                          index,
                          "label",
                          event.target.value,
                        )
                      }
                      placeholder="Descrição"
                    />
                    <input
                      value={row.value}
                      onChange={(event) =>
                        patchRow(
                          setCostItems,
                          index,
                          "value",
                          event.target.value,
                        )
                      }
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Valor"
                    />
                  </Row>
                ))}
              </Repeater>
              <Repeater
                title="Preços por volume"
                add={() =>
                  setTiers((rows) => [
                    ...rows,
                    { minimumQty: "", maximumQty: "", price: "" },
                  ])
                }
              >
                {tiers.map((row, index) => (
                  <Row
                    key={index}
                    remove={() => setTiers((rows) => removeAt(rows, index))}
                  >
                    <input
                      value={row.minimumQty}
                      onChange={(event) =>
                        patchRow(
                          setTiers,
                          index,
                          "minimumQty",
                          event.target.value,
                        )
                      }
                      type="number"
                      min="1"
                      placeholder="Qtd. mínima"
                    />
                    <input
                      value={row.maximumQty}
                      onChange={(event) =>
                        patchRow(
                          setTiers,
                          index,
                          "maximumQty",
                          event.target.value,
                        )
                      }
                      type="number"
                      min="1"
                      placeholder="Qtd. máxima"
                    />
                    <input
                      value={row.price}
                      onChange={(event) =>
                        patchRow(setTiers, index, "price", event.target.value)
                      }
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Preço unitário"
                    />
                  </Row>
                ))}
              </Repeater>
            </Section>
          }

          {
            <Section
              tabId="estoque"
              active={tab === "estoque"}
              title="Estoque, embalagem e entrega"
              note="Unidades explícitas evitam erros de frete e integração."
            >
              <Checks>
                <Check
                  name="manageStock"
                  label="Gerenciar estoque"
                  checked={item?.manageStock !== false}
                />
                <Check
                  name="soldIndividually"
                  label="Vender individualmente"
                  checked={Boolean(item?.soldIndividually)}
                />
                <Check
                  name="virtual"
                  label="Virtual / sem entrega física"
                  checked={Boolean(item?.virtual)}
                />
                <Check
                  name="freeShipping"
                  label="Frete grátis"
                  checked={Boolean(item?.freeShipping)}
                />
              </Checks>
              <Field label={mode === "edit" ? "Estoque disponível (consulta)" : "Estoque inicial"} hint={mode === "edit" ? "Use Movimentar estoque na listagem para registrar entradas e saídas com rastreabilidade." : "Informe somente o saldo de abertura. Nas cópias, o estoque começa em zero."}>
                <input
                  name="stock"
                  readOnly={mode === "edit"}
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={item?.stock || 0}
                />
              </Field>
              <Field label="Estoque mínimo">
                <input
                  name="minStock"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={item?.catalogMinStock ?? item?.minStock ?? 0}
                />
              </Field>
              <Field label="Situação">
                <select
                  name="stockStatus"
                  defaultValue={item?.stockStatus || "instock"}
                >
                  <option value="instock">Em estoque</option>
                  <option value="outofstock">Esgotado</option>
                  <option value="onbackorder">Sob encomenda</option>
                </select>
              </Field>
              <Field label="Pedidos sem estoque">
                <select
                  name="backorders"
                  defaultValue={item?.backorders || "no"}
                >
                  <option value="no">Não permitir</option>
                  <option value="notify">Permitir e avisar</option>
                  <option value="yes">Permitir</option>
                </select>
              </Field>
              <Field label="Unidade comercial">
                <select name="unit" defaultValue={item?.unit || "UN"}>
                  {[
                    "UN",
                    "KG",
                    "GR",
                    "MT",
                    "CM",
                    "MM",
                    "ML",
                    "LT",
                    "M2",
                    "M3",
                    "PC",
                    "CX",
                    "PAR",
                    "DZ",
                    "KIT",
                    "SV",
                  ].map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
              </Field>
              <Field label="Peso">
                <input
                  name="weight"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={value(item?.weight)}
                />
              </Field>
              <Field label="Unidade do peso">
                <select
                  name="weightUnit"
                  defaultValue={item?.weightUnit || "kg"}
                >
                  <option value="kg">Quilograma (kg)</option>
                  <option value="g">Grama (g)</option>
                  <option value="mg">Miligrama (mg)</option>
                  <option value="lb">Libra (lb)</option>
                  <option value="oz">Onça (oz)</option>
                </select>
              </Field>
              <Field label="Comprimento">
                <input
                  name="length"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.length)}
                />
              </Field>
              <Field label="Largura">
                <input
                  name="width"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.width)}
                />
              </Field>
              <Field label="Altura">
                <input
                  name="height"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.height)}
                />
              </Field>
              <Field label="Unidade das dimensões">
                <select
                  name="dimensionUnit"
                  defaultValue={item?.dimensionUnit || "cm"}
                >
                  <option value="cm">Centímetro (cm)</option>
                  <option value="m">Metro (m)</option>
                  <option value="mm">Milímetro (mm)</option>
                  <option value="in">Polegada (in)</option>
                </select>
              </Field>
              <Field label="Peso líquido">
                <input
                  name="netWeight"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={value(item?.netWeight)}
                />
              </Field>
              <Field label="Peso bruto">
                <input
                  name="grossWeight"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={value(item?.grossWeight)}
                />
              </Field>
              <Field label="Volumes">
                <input
                  name="volumes"
                  type="number"
                  min="0"
                  defaultValue={value(item?.volumes)}
                />
              </Field>
              <Field label="Itens por caixa">
                <input
                  name="itemsPerBox"
                  type="number"
                  min="0"
                  step="0.001"
                  defaultValue={value(item?.itemsPerBox)}
                />
              </Field>
              <Field label="Classe de frete">
                <input
                  name="shippingClass"
                  defaultValue={item?.shippingClass || ""}
                />
              </Field>
              <Field label="Preparação / cross docking (dias)">
                <input
                  name="crossDockingDays"
                  type="number"
                  min="0"
                  defaultValue={value(item?.crossDockingDays)}
                />
              </Field>
              <Field label="Garantia (meses)">
                <input
                  name="warrantyMonths"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={value(item?.warrantyMonths)}
                />
              </Field>
            </Section>
          }

          {
            <Section
              tabId="fiscal"
              active={tab === "fiscal"}
              title="Fiscal e regulatório"
              note="Os campos não são inventados: itens incompletos permanecem não prontos para o destino."
            >
              <Field label="Condição">
                <select
                  name="condition"
                  defaultValue={item?.condition || "new"}
                >
                  <option value="new">Novo</option>
                  <option value="used">Usado</option>
                  <option value="refurbished">Recondicionado</option>
                  <option value="not_specified">Não especificado</option>
                </select>
              </Field>
              <Field label="Tipo fiscal">
                <select
                  name="fiscalType"
                  defaultValue={item?.fiscalType || item?.type || "product"}
                >
                  <option value="product">Produto</option>
                  {features.services && <option value="service">Serviço</option>}
                </select>
              </Field>
              <Field label="Produção">
                <select name="production" defaultValue={item?.production || ""}>
                  <option value="">Não informado</option>
                  <option value="own">Própria</option>
                  <option value="third_party">Terceiros</option>
                </select>
              </Field>
              <Field label="Validade">
                <input
                  name="expiryDate"
                  type="date"
                  defaultValue={dateOnly(item?.expiryDate || item?.expiry)}
                />
              </Field>
              <Field label="GTIN tributário">
                <input
                  name="gtinTributary"
                  inputMode="numeric"
                  defaultValue={item?.gtinTributary || ""}
                />
              </Field>
              <Field label="NCM">
                <input
                  name="ncm"
                  inputMode="numeric"
                  maxLength={10}
                  defaultValue={item?.ncm || ""}
                />
              </Field>
              <Field label="CEST">
                <input
                  name="cest"
                  inputMode="numeric"
                  maxLength={9}
                  defaultValue={item?.cest || ""}
                />
              </Field>
              <Checks>
                <Check
                  name="cestNotApplicable"
                  label="CEST não se aplica a este produto"
                  checked={Boolean(item?.cestNotApplicable)}
                />
              </Checks>
              <Field label="Origem ICMS">
                <select name="origin" defaultValue={item?.origin ?? ""}>
                  <option value="">Selecione</option>
                  {Array.from({ length: 9 }, (_, index) => (
                    <option value={index} key={index}>
                      {index} — {originLabel(index)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tipo do item SPED">
                <input
                  name="spedItemType"
                  inputMode="numeric"
                  maxLength={2}
                  defaultValue={item?.spedItemType || ""}
                />
              </Field>
              <Field label="Alíquota aproximada de tributos (%)">
                <input
                  name="taxBurdenRate"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.taxBurdenRate)}
                />
              </Field>
              <Field label="Status tributário">
                <select
                  name="taxStatus"
                  defaultValue={item?.taxStatus || "taxable"}
                >
                  <option value="taxable">Tributável</option>
                  <option value="shipping">Somente frete</option>
                  <option value="none">Não tributável</option>
                </select>
              </Field>
              <Field label="Classe tributária">
                <input name="taxClass" defaultValue={item?.taxClass || ""} />
              </Field>
              <Field label="CSOSN">
                <input
                  name="csosn"
                  maxLength={4}
                  defaultValue={item?.csosn || ""}
                />
              </Field>
              <Field label="FCI">
                <input name="fci" defaultValue={item?.fci || ""} />
              </Field>
              <Field label="Base ICMS-ST">
                <input
                  name="icmsStBase"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.icmsStBase)}
                />
              </Field>
              <Field label="Valor ICMS-ST">
                <input
                  name="icmsStValue"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.icmsStValue)}
                />
              </Field>
              <Field label="ICMS substituto">
                <input
                  name="icmsSubstituteValue"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.icmsSubstituteValue)}
                />
              </Field>
              <Field label="Código EX TIPI">
                <input
                  name="ipiExceptionCode"
                  defaultValue={item?.ipiExceptionCode || ""}
                />
              </Field>
              <Field label="Classe de enquadramento IPI">
                <input
                  name="ipiClassification"
                  defaultValue={item?.ipiClassification || ""}
                />
              </Field>
              <Field label="PIS fixo">
                <input
                  name="pisFixedValue"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.pisFixedValue)}
                />
              </Field>
              <Field label="COFINS fixo">
                <input
                  name="cofinsFixedValue"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={value(item?.cofinsFixedValue)}
                />
              </Field>
              <Field label="Código ANATEL">
                <input
                  name="anatelCode"
                  defaultValue={item?.anatelCode || ""}
                />
              </Field>
              <Field label="Código ANVISA">
                <input
                  name="anvisaCode"
                  defaultValue={item?.anvisaCode || ""}
                />
              </Field>
              <Field label="Código INMETRO">
                <input
                  name="inmetroCode"
                  defaultValue={item?.inmetroCode || ""}
                />
              </Field>
              <Field label="Código MAPA">
                <input name="mapaCode" defaultValue={item?.mapaCode || ""} />
              </Field>
              <Field label="Informações adicionais da NF" wide>
                <textarea
                  name="additionalInvoiceInfo"
                  defaultValue={item?.additionalInvoiceInfo || ""}
                  rows={4}
                />
              </Field>
            </Section>
          }

          {
            <Section
              tabId="midia"
              active={tab === "midia"}
              title="Imagens, vídeo e arquivos"
              note="Mídias vêm da biblioteca privada da organização."
            >
              <div className="product-media-picker">
                <MediaPicker
                  value={primaryImage}
                  onChange={(asset) => { setPrimaryImage(asset); setDirty(true); }}
                  acceptKind="image"
                  label="Imagem principal"
                />
              </div>
              <div className="product-media-picker">
                <MediaPicker
                  value={ogImage}
                  onChange={(asset) => { setOgImage(asset); setDirty(true); }}
                  acceptKind="image"
                  label="Imagem social / Open Graph"
                />
              </div>
              <Repeater
                title="Galeria ordenada"
                add={() =>
                  galleryPick &&
                  !gallery.some((asset) => asset.id === galleryPick.id) &&
                  setGallery((rows) => [...rows, galleryPick])
                }
              >
                <div className="product-gallery-picker">
                  <MediaPicker
                    value={galleryPick}
                    onChange={setGalleryPick}
                    acceptKind="image"
                    label="Adicionar imagem"
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!galleryPick}
                    onClick={() => {
                      if (
                        galleryPick &&
                        !gallery.some((asset) => asset.id === galleryPick.id)
                      )
                        setGallery((rows) => [...rows, galleryPick]);
                      setGalleryPick(null);
                    }}
                  >
                    Adicionar à galeria
                  </button>
                </div>
                {gallery.map((asset, index) => (
                  <article className="product-gallery-item" key={asset.id}>
                    <img src={asset.url} alt={asset.altText || asset.name} />
                    <span>
                      <strong>
                        {index + 1}. {asset.name}
                      </strong>
                      <small>{asset.altText || "Sem texto alternativo"}</small>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setGallery((rows) => move(rows, index, -1))
                      }
                      disabled={index === 0}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => setGallery((rows) => move(rows, index, 1))}
                      disabled={index === gallery.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setGallery((rows) => removeAt(rows, index))
                      }
                    >
                      Remover
                    </button>
                  </article>
                ))}
              </Repeater>
              <Field label="Tipo de vídeo">
                <select name="videoType" defaultValue={item?.videoType || ""}>
                  <option value="">Sem vídeo</option>
                  <option value="upload">Upload</option>
                  <option value="youtube">YouTube</option>
                  <option value="vimeo">Vimeo</option>
                  <option value="instagram">Instagram</option>
                </select>
              </Field>
              <Field label="URL do vídeo">
                <input
                  name="videoUrl"
                  type="url"
                  defaultValue={item?.videoUrl || ""}
                />
              </Field>
              <Field label="Proporção">
                <select
                  name="videoAspectRatio"
                  defaultValue={item?.videoAspectRatio || ""}
                >
                  <option value="">Automática</option>
                  <option value="1:1">1:1</option>
                  <option value="3:4">3:4</option>
                  <option value="9:16">9:16</option>
                </select>
              </Field>
              <div className="product-media-picker">
                <MediaPicker
                  value={videoMedia}
                  onChange={(asset) => { setVideoMedia(asset); setDirty(true); }}
                  acceptKind="video"
                  label="Arquivo de vídeo"
                />
              </div>
              <div className="product-media-picker">
                <MediaPicker
                  value={videoThumb}
                  onChange={(asset) => { setVideoThumb(asset); setDirty(true); }}
                  acceptKind="image"
                  label="Capa do vídeo"
                />
              </div>
              <Checks>
                <Check
                  name="downloadable"
                  label="Produto baixável"
                  checked={Boolean(item?.downloadable)}
                />
              </Checks>
              <Field label="Limite de downloads">
                <input
                  name="downloadLimit"
                  type="number"
                  min="0"
                  defaultValue={value(item?.downloadLimit)}
                />
              </Field>
              <Field label="Expiração do download (dias)">
                <input
                  name="downloadExpiryDays"
                  type="number"
                  min="0"
                  defaultValue={value(item?.downloadExpiryDays)}
                />
              </Field>
              <Repeater
                title="Arquivos para download"
                add={() =>
                  setDownloads((rows) => [
                    ...rows,
                    { name: "", url: "", media: null },
                  ])
                }
              >
                {downloads.map((row, index) => (
                  <article className="product-download-row" key={index}>
                    <div>
                      <input
                        value={row.name}
                        onChange={(event) =>
                          patchRow(
                            setDownloads,
                            index,
                            "name",
                            event.target.value,
                          )
                        }
                        placeholder="Nome do arquivo"
                      />
                      <input
                        value={row.url}
                        onChange={(event) =>
                          patchRow(
                            setDownloads,
                            index,
                            "url",
                            event.target.value,
                          )
                        }
                        type="url"
                        placeholder="URL protegida ou externa"
                      />
                    </div>
                    <MediaPicker
                      value={row.media}
                      onChange={(asset) =>
                        patchRow(setDownloads, index, "media", asset)
                      }
                      acceptKind="document"
                      label="Ou selecione um documento"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setDownloads((rows) => removeAt(rows, index))
                      }
                    >
                      Remover
                    </button>
                  </article>
                ))}
              </Repeater>
            </Section>
          }

          {
            <Section
              tabId="variacoes"
              active={tab === "variacoes"}
              title="Atributos, opções e variações"
              note="A variação pode herdar estoque, medidas e preço do produto pai."
            >
              <Field label="Regra da variação padrão">
                <select
                  name="defaultVariationRule"
                  defaultValue={item?.defaultVariationRule || "lowest_price"}
                >
                  <option value="lowest_price">Menor preço disponível</option>
                  <option value="first_available">Primeira disponível</option>
                  <option value="manual">Seleção manual</option>
                </select>
              </Field>
              <Repeater
                title="Atributos"
                add={() =>
                  setAttributes((rows) => [
                    ...rows,
                    {
                      name: "",
                      type: "select",
                      swatchType: "select",
                      scope: "local",
                      visible: true,
                      variation: false,
                      options: "",
                    },
                  ])
                }
              >
                {attributes.map((row, index) => (
                  <article className="product-complex-row" key={index}>
                    <div>
                      <input
                        value={row.name}
                        onChange={(event) =>
                          patchRow(
                            setAttributes,
                            index,
                            "name",
                            event.target.value,
                          )
                        }
                        placeholder="Nome: Cor, Tamanho…"
                      />
                      <select
                        value={row.scope}
                        onChange={(event) =>
                          patchRow(
                            setAttributes,
                            index,
                            "scope",
                            event.target.value,
                          )
                        }
                      >
                        <option value="local">Local deste produto</option>
                        <option value="global">Global</option>
                      </select>
                      <select
                        value={row.type}
                        onChange={(event) =>
                          patchRow(
                            setAttributes,
                            index,
                            "type",
                            event.target.value,
                          )
                        }
                      >
                        <option value="select">Seleção</option>
                        <option value="text">Texto</option>
                      </select>
                      <select
                        value={row.swatchType}
                        onChange={(event) =>
                          patchRow(
                            setAttributes,
                            index,
                            "swatchType",
                            event.target.value,
                          )
                        }
                      >
                        <option value="select">Lista</option>
                        <option value="color">Cor</option>
                        <option value="image">Imagem</option>
                        <option value="text">Texto</option>
                        <option value="button">Botão</option>
                        <option value="color_image">Cor + imagem</option>
                        <option value="color_label">Cor + rótulo</option>
                        <option value="image_label">Imagem + rótulo</option>
                      </select>
                      <input
                        value={row.options}
                        onChange={(event) =>
                          patchRow(
                            setAttributes,
                            index,
                            "options",
                            event.target.value,
                          )
                        }
                        placeholder="Preto|#000000, Branco|#ffffff"
                      />
                    </div>
                    <div>
                      <label>
                        <input
                          type="checkbox"
                          checked={row.visible}
                          onChange={(event) =>
                            patchRow(
                              setAttributes,
                              index,
                              "visible",
                              event.target.checked,
                            )
                          }
                        />{" "}
                        Visível
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={row.variation}
                          onChange={(event) =>
                            patchRow(
                              setAttributes,
                              index,
                              "variation",
                              event.target.checked,
                            )
                          }
                        />{" "}
                        Usado em variações
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setAttributes((rows) => removeAt(rows, index))
                        }
                      >
                        Remover
                      </button>
                    </div>
                  </article>
                ))}
              </Repeater>
              <Repeater
                title="Variações"
                add={() => setVariations((rows) => [...rows, emptyVariation()])}
              >
                {variations.map((row, index) => (
                  <article
                    className="product-variation-row"
                    key={row.id ?? `new-${index}`}
                  >
                    <header>
                      <strong>Variação {index + 1}</strong>
                      <label>
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(event) =>
                            patchRow(
                              setVariations,
                              index,
                              "enabled",
                              event.target.checked,
                            )
                          }
                        />{" "}
                        Ativa
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setVariations((rows) => removeAt(rows, index))
                        }
                      >
                        Remover
                      </button>
                    </header>
                    <div>
                      <input
                        value={row.sku}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "sku",
                            event.target.value,
                          )
                        }
                        placeholder="SKU"
                      />
                      <input
                        value={row.gtin}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "gtin",
                            event.target.value,
                          )
                        }
                        placeholder="GTIN"
                      />
                      <input
                        className="wide"
                        value={row.attributes}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "attributes",
                            event.target.value,
                          )
                        }
                        placeholder="Cor=Preto; Tamanho=M"
                      />
                      <input
                        value={row.regularPrice}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "regularPrice",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Preço regular"
                      />
                      <input
                        value={row.salePrice}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "salePrice",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Preço promocional"
                      />
                      <label>
                        Início da promoção
                        <input
                          value={row.saleStartsAt}
                          onChange={(event) =>
                            patchRow(
                              setVariations,
                              index,
                              "saleStartsAt",
                              event.target.value,
                            )
                          }
                          type="datetime-local"
                        />
                      </label>
                      <label>
                        Fim da promoção
                        <input
                          value={row.saleEndsAt}
                          onChange={(event) =>
                            patchRow(
                              setVariations,
                              index,
                              "saleEndsAt",
                              event.target.value,
                            )
                          }
                          type="datetime-local"
                        />
                      </label>
                      <select
                        value={row.manageStock}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "manageStock",
                            event.target.value,
                          )
                        }
                      >
                        <option value="parent">Herdar estoque do pai</option>
                        <option value="true">Estoque próprio</option>
                        <option value="false">Sem gestão</option>
                      </select>
                      <input
                        value={row.stock}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "stock",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        placeholder="Estoque"
                      />
                      <select
                        value={row.stockStatus}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "stockStatus",
                            event.target.value,
                          )
                        }
                      >
                        <option value="">Herdar situação</option>
                        <option value="instock">Em estoque</option>
                        <option value="outofstock">Esgotado</option>
                        <option value="onbackorder">Sob encomenda</option>
                      </select>
                      <select
                        value={row.backorders}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "backorders",
                            event.target.value,
                          )
                        }
                      >
                        <option value="">Herdar encomendas</option>
                        <option value="no">Não permitir</option>
                        <option value="notify">Permitir e avisar</option>
                        <option value="yes">Permitir</option>
                      </select>
                      <input
                        value={row.weight}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "weight",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        step="0.001"
                        placeholder="Peso"
                      />
                      <input
                        value={row.length}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "length",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        placeholder="Comprimento"
                      />
                      <input
                        value={row.width}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "width",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        placeholder="Largura"
                      />
                      <input
                        value={row.height}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "height",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        placeholder="Altura"
                      />
                      <div className="wide product-variation-media">
                        <MediaPicker
                          value={row.image}
                          onChange={(asset) =>
                            patchRow(setVariations, index, "image", asset)
                          }
                          acceptKind="image"
                          label="Imagem principal da variação"
                        />
                        <MediaPicker
                          value={row.galleryPick}
                          onChange={(asset) =>
                            patchRow(setVariations, index, "galleryPick", asset)
                          }
                          acceptKind="image"
                          label="Adicionar à galeria da variação"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              row.galleryPick &&
                              !row.gallery.some(
                                (asset) => asset.id === row.galleryPick?.id,
                              )
                            ) {
                              patchRow(setVariations, index, "gallery", [
                                ...row.gallery,
                                row.galleryPick,
                              ]);
                              patchRow(
                                setVariations,
                                index,
                                "galleryPick",
                                null,
                              );
                            }
                          }}
                        >
                          Adicionar imagem
                        </button>
                      </div>
                      {row.gallery.length > 0 && (
                        <div className="wide product-variation-gallery">
                          {row.gallery.map((asset, mediaIndex) => (
                            <span key={asset.id}>
                              <img
                                src={asset.url}
                                alt={asset.altText || asset.name}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  patchRow(
                                    setVariations,
                                    index,
                                    "gallery",
                                    removeAt(row.gallery, mediaIndex),
                                  )
                                }
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <input
                        className="wide"
                        value={row.videoUrl}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "videoUrl",
                            event.target.value,
                          )
                        }
                        type="url"
                        placeholder="Vídeo exclusivo da variação"
                      />
                      <textarea
                        className="wide"
                        value={row.description}
                        onChange={(event) =>
                          patchRow(
                            setVariations,
                            index,
                            "description",
                            event.target.value,
                          )
                        }
                        placeholder="Descrição da variação"
                      />
                    </div>
                  </article>
                ))}
              </Repeater>
            </Section>
          }

          {
            <Section
              tabId="seo"
              active={tab === "seo"}
              title="SEO e compartilhamento"
              note="Prévia e validação ficam baseadas nos dados persistidos."
            >
              <Field label="Título SEO" wide>
                <input
                  name="seoTitle"
                  defaultValue={item?.seoTitle || ""}
                  maxLength={70}
                  placeholder={item?.name || "Título para buscadores"}
                />
              </Field>
              <Field label="Descrição SEO" wide>
                <textarea
                  name="seoDescription"
                  defaultValue={item?.seoDescription || ""}
                  maxLength={180}
                  rows={4}
                />
              </Field>
              <Field label="Palavra-chave principal">
                <input
                  name="seoFocusKeyword"
                  defaultValue={item?.seoFocusKeyword || ""}
                />
              </Field>
              <Field label="Palavras-chave secundárias">
                <input
                  name="seoSecondaryKeywords"
                  defaultValue={(item?.seoSecondaryKeywords || []).join(", ")}
                  placeholder="Separe por vírgula"
                />
              </Field>
              <Field label="URL canônica">
                <input
                  name="seoCanonical"
                  type="url"
                  defaultValue={item?.seoCanonical || ""}
                />
              </Field>
              <Field label="Tipo de schema">
                <select
                  name="seoSchemaType"
                  defaultValue={
                    item?.seoSchemaType ||
                    (item?.type === "service" ? "Service" : "Product")
                  }
                >
                  <option value="Product">Produto</option>
                  {features.services && <option value="Service">Serviço</option>}
                  <option value="SoftwareApplication">Software</option>
                </select>
              </Field>
              <Field label="Pontuação SEO (0–100)">
                <input
                  name="seoScore"
                  type="number"
                  min="0"
                  max="100"
                  defaultValue={value(item?.seoScore)}
                />
              </Field>
              <Checks>
                <Check
                  name="seoNoindex"
                  label="Não indexar nos buscadores"
                  checked={Boolean(item?.seoNoindex)}
                />
              </Checks>
              <div className="product-media-picker">
                <MediaPicker
                  value={ogImage}
                  onChange={(asset) => { setOgImage(asset); setDirty(true); }}
                  acceptKind="image"
                  label="Imagem de compartilhamento"
                />
              </div>
              <article className="product-seo-preview">
                <small>PRÉVIA DE BUSCA</small>
                <strong>
                  {item?.seoTitle || item?.name || "Nome do produto"}
                </strong>
                <span>
                  nalven.com.br/produto/{item?.slug || "slug-do-produto"}
                </span>
                <p>
                  {item?.seoDescription ||
                    item?.shortDescription ||
                    "Adicione uma descrição SEO clara para melhorar a apresentação nos resultados."}
                </p>
              </article>
            </Section>
          }

          {
            <Section
              tabId="extras"
              active={tab === "extras"}
              title="Vínculos, selos e configurador"
              note="Recursos de venda complementar e campos personalizados sem expor dados técnicos."
            >
              <Field label="Tags" wide>
                <input
                  name="tags"
                  defaultValue={(item?.tagLinks || [])
                    .map((row: any) => row.tag.name)
                    .join(", ")}
                  placeholder="Separe por vírgula"
                />
              </Field>
              <Repeater
                title="Produtos relacionados"
                add={() =>
                  setRelations((rows) => [
                    ...rows,
                    { type: "upsell", relatedProductId: "" },
                  ])
                }
              >
                {relations.map((row, index) => (
                  <Row
                    key={index}
                    remove={() => setRelations((rows) => removeAt(rows, index))}
                  >
                    <select
                      value={row.type}
                      onChange={(event) =>
                        patchRow(
                          setRelations,
                          index,
                          "type",
                          event.target.value,
                        )
                      }
                    >
                      <option value="upsell">Venda superior (upsell)</option>
                      <option value="cross_sell">Venda cruzada</option>
                      <option value="grouped">Produto agrupado</option>
                    </select>
                    <select
                      value={row.relatedProductId}
                      onChange={(event) =>
                        patchRow(
                          setRelations,
                          index,
                          "relatedProductId",
                          event.target.value,
                        )
                      }
                    >
                      <option value="">Selecione o produto</option>
                      {products
                        .filter((product) => product.id !== item?.id)
                        .map((product) => (
                          <option value={product.id} key={product.id}>
                            {product.name} · {product.sku}
                          </option>
                        ))}
                    </select>
                  </Row>
                ))}
              </Repeater>
              <Repeater
                title="Selos do produto"
                add={() =>
                  setBadges((rows) => [
                    ...rows,
                    { label: "", value: "#168151" },
                  ])
                }
              >
                {badges.map((row, index) => (
                  <Row
                    key={index}
                    remove={() => setBadges((rows) => removeAt(rows, index))}
                  >
                    <input
                      value={row.label}
                      onChange={(event) =>
                        patchRow(setBadges, index, "label", event.target.value)
                      }
                      placeholder="Ex.: Lançamento"
                    />
                    <input
                      value={row.value}
                      onChange={(event) =>
                        patchRow(setBadges, index, "value", event.target.value)
                      }
                      type="color"
                    />
                  </Row>
                ))}
              </Repeater>
              <Repeater
                title="Campos personalizados"
                add={() =>
                  setCustomFields((rows) => [...rows, { label: "", value: "" }])
                }
              >
                {customFields.map((row, index) => (
                  <Row
                    key={index}
                    remove={() =>
                      setCustomFields((rows) => removeAt(rows, index))
                    }
                  >
                    <input
                      value={row.label}
                      onChange={(event) =>
                        patchRow(
                          setCustomFields,
                          index,
                          "label",
                          event.target.value,
                        )
                      }
                      placeholder="Nome do campo"
                    />
                    <input
                      value={row.value}
                      onChange={(event) =>
                        patchRow(
                          setCustomFields,
                          index,
                          "value",
                          event.target.value,
                        )
                      }
                      placeholder="Valor"
                    />
                  </Row>
                ))}
              </Repeater>
              <Repeater
                title="Configurador e opcionais"
                add={() =>
                  setConfigurator((rows) => [
                    ...rows,
                    { label: "", type: "text", required: false, price: "" },
                  ])
                }
              >
                {configurator.map((row, index) => (
                  <Row
                    key={index}
                    remove={() =>
                      setConfigurator((rows) => removeAt(rows, index))
                    }
                  >
                    <input
                      value={row.label}
                      onChange={(event) =>
                        patchRow(
                          setConfigurator,
                          index,
                          "label",
                          event.target.value,
                        )
                      }
                      placeholder="Pergunta ou opção"
                    />
                    <select
                      value={row.type}
                      onChange={(event) =>
                        patchRow(
                          setConfigurator,
                          index,
                          "type",
                          event.target.value,
                        )
                      }
                    >
                      {[
                        "text",
                        "textarea",
                        "number",
                        "range",
                        "color",
                        "date",
                        "time",
                        "upload",
                        "select",
                        "radio",
                        "checkbox",
                        "swatch",
                        "product",
                        "heading",
                      ].map((type) => (
                        <option value={type} key={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    <input
                      value={row.price}
                      onChange={(event) =>
                        patchRow(
                          setConfigurator,
                          index,
                          "price",
                          event.target.value,
                        )
                      }
                      type="number"
                      step="0.01"
                      placeholder="Acréscimo"
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={row.required}
                        onChange={(event) =>
                          patchRow(
                            setConfigurator,
                            index,
                            "required",
                            event.target.checked,
                          )
                        }
                      />{" "}
                      Obrigatório
                    </label>
                  </Row>
                ))}
              </Repeater>
              <Checks>
                <Check
                  name="carouselEnabled"
                  label="Exibir em carrossel"
                  checked={Boolean(item?.carouselConfig?.enabled)}
                />
                <Check
                  name="carouselAutoplay"
                  label="Avanço automático"
                  checked={Boolean(item?.carouselConfig?.autoplay)}
                />
              </Checks>
              <Field label="Intervalo do carrossel (segundos)">
                <input
                  name="carouselInterval"
                  type="number"
                  min="1"
                  defaultValue={item?.carouselConfig?.interval || 5}
                />
              </Field>
            </Section>
          }

          {
            <Section
              tabId="marketplaces"
              active={tab === "marketplaces"}
              title="Dados por canal"
              note="Cada conta mantém categoria, catálogo, preço, estoque e ficha técnica próprios."
            >
              <div className="product-readiness">
                <strong>Prontidão será recalculada ao salvar</strong>
                <span>
                  Campos obrigatórios variam por plataforma e categoria. Um
                  canal sem perfil nunca será marcado como 100% pronto.
                </span>
              </div>
              <Repeater
                title="Perfis de marketplace"
                add={() =>
                  setMarketplaces((rows) => [...rows, emptyMarketplace()])
                }
              >
                {marketplaces.map((row, index) => (
                  <article className="product-marketplace-row" key={index}>
                    <header>
                      <select
                        value={row.platform}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "platform",
                            event.target.value,
                          )
                        }
                      >
                        <option value="mercado_livre">Mercado Livre</option>
                        <option value="shopee">Shopee</option>
                        <option value="tiktok_shop">TikTok Shop</option>
                        <option value="plug4market">Plug4Market</option>
                        <option value="bling">Bling / ERP</option>
                        <option value="amazon">Amazon (perfil)</option>
                        <option value="google">Google Merchant</option>
                      </select>
                      <select
                        value={row.channelId}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "channelId",
                            event.target.value,
                          )
                        }
                      >
                        <option value="">Sem conta vinculada</option>
                        {channels.map((channel) => (
                          <option value={channel.id} key={channel.id}>
                            {channel.name} · {channel.provider}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          setMarketplaces((rows) => removeAt(rows, index))
                        }
                      >
                        Remover
                      </button>
                    </header>
                    <div>
                      <input
                        value={row.remoteCategoryId}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "remoteCategoryId",
                            event.target.value,
                          )
                        }
                        placeholder="ID da categoria remota"
                      />
                      <input
                        value={row.remoteCatalogProductId}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "remoteCatalogProductId",
                            event.target.value,
                          )
                        }
                        placeholder="ID do catálogo remoto"
                      />
                      <input
                        value={row.listingType}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "listingType",
                            event.target.value,
                          )
                        }
                        placeholder="Tipo do anúncio"
                      />
                      <input
                        value={row.priceOverride}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "priceOverride",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Preço específico"
                      />
                      <input
                        value={row.stockOverride}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "stockOverride",
                            event.target.value,
                          )
                        }
                        type="number"
                        min="0"
                        placeholder="Estoque específico"
                      />
                      <textarea
                        className="wide"
                        value={row.attributes}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "attributes",
                            event.target.value,
                          )
                        }
                        placeholder={
                          "Ficha técnica, uma por linha:\nBRAND=Minha marca\nCOLOR=Preto"
                        }
                      />
                      <textarea
                        className="wide"
                        value={row.saleTerms}
                        onChange={(event) =>
                          patchRow(
                            setMarketplaces,
                            index,
                            "saleTerms",
                            event.target.value,
                          )
                        }
                        placeholder={
                          "Termos de venda, um por linha:\nWARRANTY_TYPE=Garantia do vendedor\nWARRANTY_TIME=12 meses"
                        }
                      />
                    </div>
                  </article>
                ))}
              </Repeater>
            </Section>
          }
        </fieldset></ProductErrors.Provider>
        <footer className="product-catalog-footer">
          <span>
            Etapa {tabIndex + 1} de {visibleTabs.length} · {visibleTabs[tabIndex]?.[1]}
          </span>
          <div className="product-footer-nav">
            <button
              type="button"
              onClick={() => setTab(visibleTabs[Math.max(0, tabIndex - 1)][0])}
              disabled={tabIndex === 0}
            >
              Anterior
            </button>
            <button
              type="button"
              onClick={() =>
                setTab(visibleTabs[Math.min(visibleTabs.length - 1, tabIndex + 1)][0])
              }
              disabled={tabIndex === visibleTabs.length - 1}
            >
              Próxima
            </button>
          </div>
          <button type="button" onClick={requestClose}>
            {readOnly ? "Fechar" : "Cancelar"}
          </button>
          {!readOnly && <button className="primary" disabled={busy}>
            {busy
              ? "Salvando…"
              : mode === "edit"
                ? "Salvar alterações"
                : "Cadastrar item"}
          </button>}
        </footer>
      </form>
    </ErpModal>
  );
}

function Section({
  tabId,
  active,
  title,
  note,
  children,
}: {
  tabId: ProductTab;
  active: boolean;
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`product-panel-${tabId}`}
      data-product-tab={tabId}
      role="region"
      aria-labelledby={`product-tab-${tabId}`}
      hidden={!active}
      className="product-form-section"
    >
      <header>
        <h3>{title}</h3>
        <p>{note}</p>
      </header>
      <div>{children}</div>
    </section>
  );
}
function Field({ label, wide, children, required = false, hint }: {
  label: string; wide?: boolean; children: ReactNode; required?: boolean; hint?: string;
}) {
  const id = useId();
  const errors = useContext(ProductErrors).filter(issue => issue.field.id.startsWith(`${id}-`));
  const controls = Children.toArray(children);
  const mandatory = required || controls.some(child => isValidElement<{ required?: boolean }>(child) && child.props.required);
  return <div className={wide ? "product-field wide" : "product-field"}>
    <label htmlFor={`${id}-0`}><span>{label}</span>{mandatory && <strong className="product-required">Obrigatório</strong>}</label>
    {controls.map((child, index) => isValidElement<Record<string, unknown>>(child) && typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type)
      ? cloneElement(child, { id: `${id}-${index}`, "aria-label": child.props["aria-label"] || label, "aria-describedby": [hint ? `${id}-hint` : "", errors.length ? `${id}-errors` : ""].filter(Boolean).join(" ") || undefined }) : child)}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
    {errors.length > 0 && <small className="product-inline-error" id={`${id}-errors`}>{errors.map(error => error.message).join(" ")}</small>}
  </div>;
}
function Checks({ children }: { children: ReactNode }) {
  return <div className="product-form-checks wide">{children}</div>;
}
function Check({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label>
      <input name={name} type="checkbox" defaultChecked={checked} /> {label}
    </label>
  );
}
function Repeater({
  title,
  add,
  children,
}: {
  title: string;
  add: () => void;
  children: ReactNode;
}) {
  return (
    <section className="product-repeater wide">
      <header>
        <strong>{title}</strong>
        <button type="button" onClick={add}>
          + Adicionar
        </button>
      </header>
      <div>{children}</div>
    </section>
  );
}
function Row({
  remove,
  children,
}: {
  remove: () => void;
  children: ReactNode;
}) {
  return (
    <div className="product-repeat-row">
      {children}
      <button type="button" onClick={remove}>
        Remover
      </button>
    </div>
  );
}

function mediaFrom(value: any): MediaAsset | null {
  if (!value?.id) return null;
  const createdAt = String(value.createdAt || new Date().toISOString());
  return {
    id: value.id,
    name: value.name,
    originalName: value.originalName || value.name,
    mimeType: value.mimeType || "image/jpeg",
    kind: value.kind || "image",
    sizeBytes: value.sizeBytes || 0,
    altText: value.altText || "",
    description: value.description || null,
    tags: Array.isArray(value.tags) ? value.tags : [],
    folder: value.folder || "Geral",
    source: value.source || "upload",
    version: value.version || 1,
    expiresAt: value.expiresAt || null,
    uploadedByName: value.uploadedByName || "",
    createdAt,
    updatedAt: String(value.updatedAt || createdAt),
    deletedAt: null,
    favorite: false,
    versionCount: 0,
    duplicateCount: 0,
    usageCount: 1,
    url: `/api/erp/library/${value.id}/file`,
  };
}
function splitList(value: string) {
  return [
    ...new Set(
      value
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function textToPairs(value: string) {
  return value
    .split(/[;\n]/)
    .map((line) => {
      const index = line.indexOf("=");
      return index < 0
        ? null
        : {
            name: line.slice(0, index).trim(),
            value: line.slice(index + 1).trim(),
          };
    })
    .filter((item): item is { name: string; value: string } =>
      Boolean(item?.name),
    );
}
function pairsToText(value: any) {
  return jsonArray(value)
    .map(
      (row: any) =>
        `${row.name || row.id || ""}=${row.value || row.value_name || ""}`,
    )
    .filter((row: string) => !row.startsWith("="))
    .join("\n");
}
function jsonArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}
function optionalNumber(value: FormDataEntryValue | string | null) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function value(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}
function dateLocal(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? ""
    : new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
}
function dateOnly(value: unknown) {
  return value ? String(value).slice(0, 10) : "";
}
function removeAt<T>(rows: T[], index: number) {
  return rows.filter((_, rowIndex) => rowIndex !== index);
}
function move<T>(rows: T[], index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= rows.length) return rows;
  const copy = [...rows];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
function patchRow<T, K extends keyof T>(
  setter: (value: T[] | ((rows: T[]) => T[])) => void,
  index: number,
  key: K,
  value: T[K],
) {
  setter((rows: T[]) =>
    rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, [key]: value } : row,
    ),
  );
}
function emptyVariation(): VariationRow {
  return {
    id: null,
    sku: "",
    gtin: "",
    attributes: "",
    regularPrice: "",
    salePrice: "",
    saleStartsAt: "",
    saleEndsAt: "",
    manageStock: "parent",
    stock: "",
    stockStatus: "",
    backorders: "",
    weight: "",
    length: "",
    width: "",
    height: "",
    image: null,
    gallery: [],
    galleryPick: null,
    videoUrl: "",
    description: "",
    enabled: true,
  };
}
function emptyMarketplace(): MarketplaceRow {
  return {
    platform: "mercado_livre",
    channelId: "",
    remoteCategoryId: "",
    remoteCatalogProductId: "",
    listingType: "",
    priceOverride: "",
    stockOverride: "",
    attributes: "",
    saleTerms: "",
  };
}
function originLabel(index: number) {
  return [
    "Nacional",
    "Estrangeira — importação direta",
    "Estrangeira — mercado interno",
    "Nacional com conteúdo importado > 40%",
    "Nacional conforme processo produtivo básico",
    "Nacional com conteúdo importado ≤ 40%",
    "Estrangeira sem similar nacional — direta",
    "Estrangeira sem similar nacional — interna",
    "Nacional com conteúdo importado > 70%",
  ][index];
}
