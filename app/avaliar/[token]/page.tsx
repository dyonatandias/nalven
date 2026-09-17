import ReviewClient from "./review-client";
import "./review.css";
import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const token = (await params).token;
  const store = (await searchParams).loja;
  const storeSlug = typeof store === "string" ? store : "";
  return <ReviewClient key={`${storeSlug}:${token}`} token={token} storeSlug={storeSlug}/>;
}
