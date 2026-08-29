import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmbeddedSignupButton } from "@/features/whatsappIntegration/EmbeddedSignupButton";

/**
 * Hotel auth/tenant scoping already happens one level up, in
 * ClientAppShell.tsx (requireClientAccess()) — this page never receives or
 * needs a hotelId itself; EmbeddedSignupButton's own server action derives
 * it fresh from the session (see features/whatsappIntegration/actions.ts).
 */
export default function ClientWhatsAppPage() {
  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="WhatsApp" subtitle="Connectez votre compte WhatsApp Business officiel Meta." />

      <Card className="p-6">
        <EmbeddedSignupButton />
      </Card>
    </div>
  );
}
