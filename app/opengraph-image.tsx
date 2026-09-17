import { ImageResponse } from "next/og";
import { controlDb } from "@/db/control";
export const dynamic = "force-dynamic";
export const alt = "NALVEN — Gestão empresarial";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default async function Image() {
  const entries = await controlDb.siteContent.findMany({ where: { key: { in: ["brand.name", "hero.title", "hero.eyebrow"] }, public: true } });
  const values = Object.fromEntries(entries.map(entry => [entry.key, String(entry.value)]));
  return new ImageResponse(<div style={{width:"100%",height:"100%",background:"#102543",color:"white",display:"flex",flexDirection:"column",padding:80,justifyContent:"space-between"}}><div style={{display:"flex",fontSize:40,fontWeight:700,color:"#8bb9ff"}}>{values["brand.name"]}</div><div style={{display:"flex",fontSize:68,fontWeight:700,lineHeight:1.1}}>{values["hero.title"]}</div><div style={{display:"flex",fontSize:22,color:"#b6c7df"}}>{values["hero.eyebrow"]}</div></div>, size);
}
