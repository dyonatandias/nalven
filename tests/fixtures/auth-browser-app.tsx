import { createRoot } from "react-dom/client";
import LoginForm from "../../app/login/login-form";
import SignupForm from "../../app/cadastro/signup-form";
import ForgotPasswordForm from "../../app/esqueci-senha/forgot-password-form";
import ResetPasswordForm from "../../app/redefinir-senha/[token]/reset-password-form";
import InviteClient from "../../app/convite/[token]/invite-client";
import AnalyticsTracker from "../../components/analytics-tracker";
import "../../app/globals.css";

const params = new URLSearchParams(location.search);
const token = params.get("token") || "A".repeat(48);
const view = params.get("view");
const plans = [{ id: "starter", name: "Essencial", monthlyPrice: 99.9 }, { id: "advanced", name: "Gestão completa", monthlyPrice: 249.9 }];
const screen = view === "signup" ? <SignupForm plans={params.has("unavailable") ? [] : plans} selectedPlan="advanced" paymentMethods={["pix", "boleto"]} dueDay={10} />
    : view === "forgot" ? <ForgotPasswordForm />
      : view === "reset" ? <ResetPasswordForm token={token} />
        : view === "invite" ? <InviteClient token={token} />
          : <LoginForm returnTo={params.get("returnTo") || undefined} passwordChanged={params.has("changed")} />;
createRoot(document.getElementById("app")!).render(<>{params.has("tracking") && <AnalyticsTracker />}{screen}</>);
