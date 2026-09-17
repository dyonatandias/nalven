import InviteClient from "./invite-client";
export const metadata = { title: "Aceitar convite | NALVEN", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  return <InviteClient token={(await params).token} />;
}
