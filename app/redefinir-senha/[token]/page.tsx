import ResetPasswordForm from "./reset-password-form";
export const metadata = { title: "Redefinir senha | NALVEN", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) { const { token } = await params; return <ResetPasswordForm token={token} />; }
