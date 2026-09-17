import { redirect } from "@/lib/site/server-navigation";
import { currentUser } from "@/lib/auth";
import LoginForm from "./login-form";
import { safeInviteReturnTo } from "@/components/auth/safe-return";

export const metadata = { title: "Entrar | NALVEN", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string; senha?: string }> }) {
  const user = await currentUser();
  const requested = await searchParams;
  const returnTo = safeInviteReturnTo(requested.returnTo);

  if (user?.role === "superadmin") return await redirect("/admin");
  if (user?.memberships.length && !returnTo) return await redirect("/erp");
  if (user && returnTo) return await redirect(returnTo);
  if (user) return await redirect("/cadastro");

  return <LoginForm returnTo={returnTo} passwordChanged={requested.senha === "alterada"} />;
}
