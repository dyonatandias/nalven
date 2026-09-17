import "./tracking.css";
import "./tracking-enhancements.css";
import TrackingClient from "./tracking-client";
import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TrackingPage({ searchParams }: Props) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  return <TrackingClient key={`${value("loja")}:${value("pedido")}:${value("chave")}`} storeSlug={value("loja")} initialNumber={value("pedido")} orderKey={value("chave")}/>;
}
