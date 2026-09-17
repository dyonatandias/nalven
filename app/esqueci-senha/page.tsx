import { redirect } from "@/lib/site/server-navigation";
import { currentUser } from "@/lib/auth";
import ForgotPasswordForm from "./forgot-password-form";
export const metadata = { title: "Recuperar acesso | NALVEN", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function ForgotPasswordPage() { const user = await currentUser(); if (user) return await redirect(user.role === "superadmin" ? "/admin" : "/erp"); return <ForgotPasswordForm />; }
