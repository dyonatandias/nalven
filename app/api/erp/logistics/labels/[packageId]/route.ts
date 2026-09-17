import { currentOrganization, tenantDb } from "@/db";
import type { Prisma } from "@/generated/tenant/client";
import { AuthError, authErrorResponse } from "@/lib/auth";
import { assertTenantPermission } from "@/lib/erp/permissions";

export async function GET(
  request: Request,
  context: { params: Promise<{ packageId: string }> },
) {
  try {
    const organization = await currentOrganization(),
      access = await assertTenantPermission(organization.id, "logistics.read"),
      db = await tenantDb(organization.id),
      profile = await db.tenantUserProfile.findUnique({
        where: { userId: access.user.id },
        select: {
          activeBranchId: true,
          branchAccesses: {
            select: { branchId: true, branch: { select: { status: true } } },
          },
        },
      });
    if (!profile?.activeBranchId)
      return Response.json(
        { error: "Selecione uma filial ativa." },
        { status: 409 },
      );
    const branchAccess = profile.branchAccesses.find(
      (item) =>
        item.branchId === profile.activeBranchId &&
        item.branch.status === "active",
    );
    if (!branchAccess)
      return Response.json(
        { error: "Você não possui acesso à filial ativa." },
        { status: 403 },
      );
    const activeBranch = await db.branch.findUnique({
        where: { id: profile.activeBranchId },
        include: { settings: true },
      }),
      branchIds = activeBranch?.settings?.allowCrossBranchFulfillment
        ? profile.branchAccesses
            .filter((item) => item.branch.status === "active")
            .map((item) => item.branchId)
        : [profile.activeBranchId],
      { packageId } = await context.params,
      volume = await db.shipmentPackage.findFirst({
        where: {
          id: packageId,
          shipment: { warehouse: { branchId: { in: branchIds } } },
        },
        include: {
          shipment: {
            include: {
              warehouse: { include: { branch: true } },
              salesOrder: true,
              items: {
                include: {
                  salesOrderItem: { include: { product: true, variation: true } },
                },
              },
            },
          },
          items: true,
        },
      });
    if (!volume)
      return Response.json({ error: "Etiqueta não encontrada." }, { status: 404 });
    const format = new URL(request.url).searchParams.get("format")?.toLowerCase();
    if (format === "zpl")
      return new Response(zpl(volume), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `inline; filename="${safeFilename(volume.code)}.zpl"`,
          "cache-control": "private, no-store",
        },
      });
    return new Response(labelHtml(volume), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `inline; filename="${safeFilename(volume.code)}.html"`,
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("logistics_label_error", { error: error instanceof Error ? error.name : typeof error });
    return Response.json(
      { error: "Não foi possível gerar a etiqueta." },
      { status: 500 },
    );
  }
}

type LabelVolume = Prisma.ShipmentPackageGetPayload<{
  include: {
    shipment: {
      include: {
        warehouse: { include: { branch: true } };
        salesOrder: true;
        items: {
          include: {
            salesOrderItem: { include: { product: true; variation: true } };
          };
        };
      };
    };
    items: true;
  };
}>;

function labelHtml(volume: LabelVolume) {
  const order = volume.shipment.salesOrder,
    origin = volume.shipment.warehouse.branch,
    address = [
      order.deliveryStreet,
      order.deliveryNumber,
      order.deliveryComplement,
      order.deliveryDistrict,
      order.deliveryCity,
      order.deliveryState,
      order.deliveryZip,
    ]
      .filter(Boolean)
      .join(" · "),
    items = volume.items
      .map((packed) => {
        const item = volume.shipment.items.find(
          (candidate) => candidate.id === packed.shipmentItemId,
        );
        return item
          ? `<li>${escapeHtml(item.salesOrderItem.variation?.sku || item.salesOrderItem.product.sku)} · ${escapeHtml(item.salesOrderItem.product.name)} · ${packed.quantity}</li>`
          : "";
      })
      .join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(volume.code)}</title><style>
  @page{size:100mm 150mm;margin:4mm}*{box-sizing:border-box}body{margin:0;color:#111;font:13px Arial,sans-serif}.label{width:92mm;min-height:142mm;border:2px solid #111;padding:5mm;display:grid;gap:4mm}.row{display:flex;justify-content:space-between;gap:4mm}.muted{color:#444;font-size:11px;text-transform:uppercase;letter-spacing:.08em}h1{font-size:20px;margin:1mm 0}h2{font-size:16px;margin:1mm 0}.box{border:1px solid #111;padding:3mm}.barcode{width:100%;height:22mm}.tracking{text-align:center;font:700 16px monospace;letter-spacing:.12em}ul{margin:2mm 0 0;padding-left:5mm;font-size:11px}button{min-height:44px;background:#111;color:#fff;border:0;padding:0 18px;font-weight:700}@media print{button{display:none}.label{border:0}}
  </style></head><body><main class="label"><div class="row"><div><span class="muted">Origem</span><h2>${escapeHtml(origin?.name || volume.shipment.warehouse.name)}</h2></div><div><span class="muted">Volume</span><h2>${volume.sequence}/${volume.shipment.packageCount}</h2></div></div><section class="box"><span class="muted">Destinatário</span><h1>${escapeHtml(order.customerName)}</h1><p>${escapeHtml(address || "Endereço não informado")}</p></section><section><span class="muted">Rastreio</span>${code39Svg(volume.trackingCode || volume.code)}<div class="tracking">${escapeHtml(volume.trackingCode || volume.code)}</div></section><div class="row"><span>${volume.weightKg.toFixed(3)} kg</span><span>${volume.lengthCm} × ${volume.widthCm} × ${volume.heightCm} cm</span></div><section class="box"><span class="muted">Pedido ${escapeHtml(order.number)} · Expedição ${escapeHtml(volume.shipment.number)}</span><ul>${items || "<li>Conteúdo conforme pedido</li>"}</ul></section><section><span class="muted">SSCC</span>${code39Svg(volume.sscc || volume.code)}<div class="tracking">${escapeHtml(volume.sscc || volume.code)}</div></section><button onclick="window.print()">Imprimir etiqueta</button></main></body></html>`;
}

function zpl(volume: LabelVolume) {
  const order = volume.shipment.salesOrder,
    address = [
      order.deliveryStreet,
      order.deliveryNumber,
      order.deliveryDistrict,
      order.deliveryCity,
      order.deliveryState,
      order.deliveryZip,
    ]
      .filter(Boolean)
      .join(" - ");
  return `^XA
^CI28^PW800^LL1200
^FO40,35^A0N,26,26^FDORIGEM: ${zplText(volume.shipment.warehouse.name)}^FS
^FO600,35^A0N,26,26^FD${volume.sequence}/${volume.shipment.packageCount}^FS
^FO40,95^GB720,230,2^FS
^FO60,120^A0N,24,24^FDDESTINATARIO^FS
^FO60,160^A0N,38,38^FD${zplText(order.customerName)}^FS
^FO60,215^A0N,25,25^FB680,3,4,L^FD${zplText(address)}^FS
^FO90,370^BY3^BCN,130,Y,N,N^FD${zplText(volume.trackingCode || volume.code)}^FS
^FO40,570^A0N,25,25^FDPEDIDO ${zplText(order.number)}  EXP ${zplText(volume.shipment.number)}^FS
^FO40,620^A0N,25,25^FDPESO ${volume.weightKg.toFixed(3)} KG  ${volume.lengthCm}X${volume.widthCm}X${volume.heightCm} CM^FS
^FO90,720^BY3^BCN,130,Y,N,N^FD${zplText(volume.sscc || volume.code)}^FS
^XZ`;
}

const code39: Record<string, string> = {
  "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
  A:"wnnnnwnnw",B:"nnwnnwnnw",C:"wnwnnwnnn",D:"nnnnwwnnw",E:"wnnnwwnnn",F:"nnwnwwnnn",G:"nnnnnwwnw",H:"wnnnnwwnn",I:"nnwnnwwnn",J:"nnnnwwwnn",
  K:"wnnnnnnww",L:"nnwnnnnww",M:"wnwnnnnwn",N:"nnnnwnnww",O:"wnnnwnnwn",P:"nnwnwnnwn",Q:"nnnnnnwww",R:"wnnnnnwwn",S:"nnwnnnwwn",T:"nnnnwnwwn",
  U:"wwnnnnnnw",V:"nwwnnnnnw",W:"wwwnnnnnn",X:"nwnnwnnnw",Y:"wwnnwnnnn",Z:"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","$":"nwnwnwnnn","/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn","*":"nwnnwnwnn",
};

function code39Svg(value: string) {
  const safe = value.toUpperCase().replace(/[^0-9A-Z. $/+%-]/g, "-").slice(0, 48),
    encoded = `*${safe}*`;
  let x = 4;
  const bars: string[] = [];
  for (const character of encoded) {
    const pattern = code39[character] || code39["-"];
    for (let index = 0; index < pattern.length; index += 1) {
      const width = pattern[index] === "w" ? 5 : 2;
      if (index % 2 === 0)
        bars.push(`<rect x="${x}" y="2" width="${width}" height="58"/>`);
      x += width;
    }
    x += 2;
  }
  return `<svg class="barcode" viewBox="0 0 ${x + 4} 62" preserveAspectRatio="none" role="img" aria-label="Código de barras ${escapeHtml(safe)}">${bars.join("")}</svg>`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function zplText(value: unknown) {
  return String(value ?? "").replace(/[\^~]/g, " ").slice(0, 220);
}

function safeFilename(value: string) {
  return value.replace(/[^a-z0-9._-]/gi, "-").slice(0, 100);
}
