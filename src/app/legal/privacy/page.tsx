// Public, unauthenticated legal page (no session, no cookie required — see
// updateSession.ts's own PUBLIC_PATH_PREFIXES). Dedicated to Proactif
// Messaging / the hotel assistant product served from this app — NOT a
// reuse of any other Proactif product's own policy (none exists in this
// repo; written from scratch against this codebase's actual, verified data
// flows only).
import { LegalLayout } from "../LegalLayout";

const UPDATED_AT = "29 août 2026";

export const metadata = {
  title: "Politique de confidentialité — Proactif Messaging",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalLayout title="Politique de confidentialité — Proactif Messaging" updatedAt={UPDATED_AT}>
      <p>
        Cette politique de confidentialité décrit comment <strong>Proactif System</strong> traite les données à caractère personnel dans le cadre de
        <strong> Proactif Messaging</strong>, la plateforme qui fournit un assistant conversationnel hôtelier, gère les conversations avec les clients
        des hôtels, permet à un hôtel de connecter son compte WhatsApp Business via Meta, et transmet des demandes aux partenaires d&rsquo;un hôtel.
      </p>

      <h2>1. Responsable du traitement / Éditeur</h2>
      <p>
        Le service <strong>Proactif Messaging</strong>, exploité sous la marque <strong>Proactif System</strong> (nom de domaine{" "}
        <strong>proactifsystem.com</strong>), est édité par :
      </p>
      <ul>
        <li><strong>Didier Sellin</strong>, entrepreneur individuel (micro-entreprise) ;</li>
        <li>SIREN : 510 749 682 ;</li>
        <li>SIRET : 510 749 682 00058 ;</li>
        <li>Adresse : 8 rue Talairat, 43100 Brioude, France.</li>
      </ul>
      <p>Didier Sellin agit en qualité de responsable du traitement des données décrites dans la présente politique.</p>

      <h2>2. Données concernant les comptes professionnels (hôtels)</h2>
      <p>Pour les utilisateurs professionnels (personnel d&rsquo;un hôtel client), nous traitons :</p>
      <ul>
        <li>l&rsquo;adresse email associée au compte et son rôle d&rsquo;accès (administrateur d&rsquo;hôtel ou administrateur Proactif System) ;</li>
        <li>les données de configuration de l&rsquo;établissement nécessaires au fonctionnement du service (paramètres de l&rsquo;assistant, du widget de
          discussion, des types d&rsquo;hébergement, des photos et documents fournis pour alimenter l&rsquo;assistant) ;</li>
        <li>les données techniques strictement nécessaires au fonctionnement du service (journaux techniques d&rsquo;accès, identifiants internes).</li>
      </ul>

      <h2>3. Données des conversations avec l&rsquo;assistant</h2>
      <p>
        Lorsqu&rsquo;un client d&rsquo;un hôtel utilise l&rsquo;assistant conversationnel, le contenu des échanges est conservé afin de permettre à
        l&rsquo;assistant de répondre et à l&rsquo;hôtel de consulter l&rsquo;historique de la conversation. Si le client fournit volontairement un nom,
        une adresse email ou un numéro de téléphone au cours de l&rsquo;échange (par exemple pour être recontacté), ces informations sont associées à la
        conversation. Nous ne conservons pas ces données indéfiniment par principe : la durée de conservation dépend de la durée de la relation entre le
        client et l&rsquo;hôtel et des critères décrits à la section 10 ci-dessous.
      </p>

      <h2>4. Données liées à WhatsApp Business et à Meta</h2>
      <p>
        Un hôtel peut connecter son propre compte WhatsApp Business à Proactif Messaging via le parcours officiel <strong>Meta Embedded Signup</strong>.
        Dans ce cadre, nous conservons uniquement des identifiants techniques : l&rsquo;identifiant du compte WhatsApp Business (WABA ID),
        l&rsquo;identifiant du numéro de téléphone (Phone Number ID) et, lorsqu&rsquo;il est disponible, l&rsquo;identifiant de l&rsquo;entreprise Meta
        associée (Business ID), ainsi que le type et le statut de la connexion.
      </p>
      <p>
        L&rsquo;autorisation d&rsquo;accès délivrée par Meta à l&rsquo;issue de ce parcours (un jeton d&rsquo;accès technique, jamais un mot de passe) est
        chiffrée avant d&rsquo;être stockée sur nos serveurs ; elle n&rsquo;est jamais conservée en clair, jamais transmise au navigateur, et
        n&rsquo;est accessible que par un mécanisme serveur dédié et restreint. <strong>Proactif System n&rsquo;a jamais accès au mot de passe du
        compte Facebook ou Meta de l&rsquo;hôtel</strong> — la connexion est réalisée directement par l&rsquo;hôtel dans l&rsquo;interface officielle de
        Meta, jamais sur nos propres pages.
      </p>

      <h2>5. Données liées aux partenaires et à leurs demandes</h2>
      <p>
        Lorsqu&rsquo;un hôtel réfère un partenaire (par exemple un restaurant ou une activité), nous traitons le numéro de contact professionnel que ce
        partenaire a communiqué pour recevoir les demandes. Lorsqu&rsquo;un client de l&rsquo;hôtel formule une demande destinée à ce partenaire (par
        exemple une réservation), le numéro de téléphone du client peut être transmis au partenaire dans la seule mesure nécessaire au traitement de
        cette demande.
      </p>

      <h2>6. Finalités du traitement</h2>
      <ul>
        <li>fournir et faire fonctionner l&rsquo;assistant conversationnel et le service Proactif Messaging ;</li>
        <li>sécuriser le service et prévenir les accès non autorisés ;</li>
        <li>permettre la connexion d&rsquo;un compte WhatsApp Business via Meta Embedded Signup et l&rsquo;usage des fonctions WhatsApp que l&rsquo;hôtel
          active ;</li>
        <li>acheminer les demandes vers les partenaires référencés par un hôtel ;</li>
        <li>assurer le support technique et la maintenance du service ;</li>
        <li>répondre à nos obligations légales lorsqu&rsquo;elles s&rsquo;appliquent.</li>
      </ul>

      <h2>7. Base juridique</h2>
      <p>
        Ces traitements reposent selon les cas sur l&rsquo;exécution du contrat conclu avec l&rsquo;hôtel client, sur notre intérêt légitime à assurer la
        sécurité et le bon fonctionnement du service, et, lorsque cela concerne directement une personne (par exemple un client d&rsquo;hôtel ou un
        partenaire), sur son consentement explicite lorsque celui-ci est recueilli avant le traitement concerné.
      </p>

      <h2>8. Sous-traitants et prestataires</h2>
      <p>Pour fonctionner, Proactif Messaging fait appel aux prestataires suivants :</p>
      <ul>
        <li><strong>Supabase</strong>, pour l&rsquo;hébergement de la base de données et l&rsquo;authentification ;</li>
        <li><strong>Render</strong>, pour l&rsquo;hébergement de l&rsquo;application ;</li>
        <li><strong>Meta Platforms</strong> (WhatsApp), pour la connexion et l&rsquo;usage de l&rsquo;API WhatsApp Business ;</li>
        <li><strong>OpenAI</strong>, pour les fonctions de génération de réponses et de recherche documentaire de l&rsquo;assistant (traitement
          effectué exclusivement côté serveur).</li>
      </ul>

      <h2>9. Transferts hors Union européenne</h2>
      <p>
        Certains de ces prestataires sont susceptibles de traiter des données depuis des pays situés hors de l&rsquo;Union européenne. Le cas échéant,
        ces transferts s&rsquo;appuient sur les garanties et mécanismes contractuels mis en place par chacun de ces prestataires (tels que les clauses
        contractuelles types de la Commission européenne). Nous vous invitons à consulter directement la politique de confidentialité de chaque
        prestataire pour le détail exact des garanties applicables.
      </p>

      <h2>10. Durée de conservation</h2>
      <p>
        Nous ne fixons pas de durée de conservation uniforme et arbitraire pour l&rsquo;ensemble des données. Les données sont conservées le temps
        nécessaire aux finalités décrites ci-dessus : en particulier, tant que le compte de l&rsquo;hôtel est actif, tant qu&rsquo;une connexion WhatsApp
        reste active, et pendant la durée strictement nécessaire au traitement d&rsquo;une demande partenaire. Au-delà, les données sont supprimées ou
        anonymisées, sous réserve des obligations légales de conservation qui pourraient s&rsquo;appliquer.
      </p>

      <h2>11. Sécurité</h2>
      <p>
        Les données de chaque hôtel sont isolées des autres hôtels au niveau de la base de données. Les identifiants d&rsquo;accès WhatsApp sensibles
        sont chiffrés selon des standards reconnus (AES-256) avant leur stockage, et la clé de déchiffrement n&rsquo;est jamais conservée dans la base de
        données elle-même. L&rsquo;accès aux données est restreint aux traitements strictement nécessaires au fonctionnement du service. Aucune mesure
        de sécurité ne pouvant garantir une protection absolue, nous nous engageons à maintenir ces mesures à un niveau raisonnable et à les faire
        évoluer.
      </p>

      <h2>12. Vos droits</h2>
      <p>Conformément au Règlement général sur la protection des données (RGPD), vous disposez des droits suivants sur vos données :</p>
      <ul>
        <li>droit d&rsquo;accès ;</li>
        <li>droit de rectification ;</li>
        <li>droit à l&rsquo;effacement ;</li>
        <li>droit à la limitation du traitement ;</li>
        <li>droit d&rsquo;opposition, lorsque le traitement repose sur notre intérêt légitime ;</li>
        <li>droit à la portabilité des données, lorsqu&rsquo;il s&rsquo;applique ;</li>
        <li>droit de retirer votre consentement à tout moment, lorsque le traitement repose sur celui-ci.</li>
      </ul>
      <p>
        Pour exercer ces droits, notamment une demande de suppression, consultez notre page dédiée{" "}
        <a href="/suppression-donnees" className="underline hover:text-ink">
          Suppression de vos données
        </a>.
      </p>

      <h2>13. Contact</h2>
      <p>
        Pour toute question relative à cette politique ou pour exercer vos droits, vous pouvez nous contacter à l&rsquo;adresse suivante :{" "}
        <a href="mailto:sellindidier@gmail.com" className="underline hover:text-ink">
          sellindidier@gmail.com
        </a>.
      </p>

      <h2>14. Réclamation auprès de la CNIL</h2>
      <p>
        Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez adresser une réclamation à la Commission
        Nationale de l&rsquo;Informatique et des Libertés (CNIL) : <span className="whitespace-nowrap">www.cnil.fr</span>.
      </p>

      <h2>15. Mise à jour de cette politique</h2>
      <p>
        Cette politique peut être mise à jour pour refléter l&rsquo;évolution du service. La date de dernière mise à jour figure en haut de cette page.
      </p>
    </LegalLayout>
  );
}
