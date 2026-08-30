// Public, unauthenticated legal page (no session, no cookie required — see
// updateSession.ts's own PUBLIC_PATH_PREFIXES). New page for Proactif
// Messaging's Conditions d'utilisation — colocated here as the source of
// truth, same pattern as ../privacy and ../data-deletion; also reachable
// at the canonical /conditions-utilisation URL via a re-export
// (src/app/conditions-utilisation/page.tsx), created for Meta Developers'
// "Terms of Service URL" field.
//
// Describes ONLY what this codebase actually does — no invented pricing,
// contract duration, termination notice period, SLA percentage, or
// acceptance-checkbox mechanism (none of these exist in this project;
// confirmed by audit before writing this page).
import { LegalLayout } from "../LegalLayout";

const UPDATED_AT = "30 août 2026";

export const metadata = {
  title: "Conditions d'utilisation — Proactif Messaging",
};

export default function TermsOfUsePage() {
  return (
    <LegalLayout title="Conditions d'utilisation — Proactif Messaging" updatedAt={UPDATED_AT}>
      <p>
        Les présentes conditions d&rsquo;utilisation décrivent les règles applicables à l&rsquo;utilisation de <strong>Proactif Messaging</strong>,
        exploité sous la marque <strong>Proactif System</strong> (nom de domaine <strong>proactifsystem.com</strong>), édité par{" "}
        <strong>Didier Sellin</strong>, entrepreneur individuel (micro-entreprise), SIREN 510 749 682, SIRET 510 749 682 00058, domicilié 8 rue
        Talairat, 43100 Brioude, France. L&rsquo;utilisation du service vaut acceptation des présentes conditions.
      </p>

      <h2>1. Description du service</h2>
      <p>
        Proactif Messaging fournit à des établissements hôteliers un assistant conversationnel destiné à leurs clients, un tableau de bord
        d&rsquo;administration, un widget de discussion intégrable sur le site de l&rsquo;hôtel, la possibilité de connecter le compte WhatsApp
        Business de l&rsquo;hôtel via le parcours officiel Meta Embedded Signup, et la mise en relation avec des partenaires référencés par
        l&rsquo;hôtel.
      </p>

      <h2>2. Accès et comptes</h2>
      <p>
        L&rsquo;accès au tableau de bord et à l&rsquo;espace client est réservé aux personnes disposant d&rsquo;un compte créé pour un établissement
        hôtelier client. Chaque utilisateur est responsable de la confidentialité de ses identifiants de connexion et des actions réalisées depuis son
        compte.
      </p>

      <h2>3. Connexion d&rsquo;un compte WhatsApp Business</h2>
      <p>
        Lorsqu&rsquo;un établissement connecte son propre compte WhatsApp Business via Meta Embedded Signup, cette connexion s&rsquo;effectue
        directement dans l&rsquo;interface officielle de Meta, jamais sur les pages de Proactif Messaging. L&rsquo;établissement reste seul responsable
        du respect des conditions d&rsquo;utilisation et des règles imposées par Meta pour l&rsquo;usage de WhatsApp Business, ainsi que de la gestion de
        son propre compte Meta.
      </p>

      <h2>4. Contenus générés par l&rsquo;assistant</h2>
      <p>
        Les réponses fournies par l&rsquo;assistant conversationnel sont générées automatiquement à partir des informations renseignées par
        l&rsquo;établissement hôtelier. Ces réponses peuvent comporter des erreurs ou des imprécisions ; Proactif Messaging ne garantit pas
        l&rsquo;exactitude absolue de chaque réponse générée, et il appartient à l&rsquo;établissement hôtelier de tenir à jour les informations
        fournies à l&rsquo;assistant et de vérifier les échanges lorsque nécessaire.
      </p>

      <h2>5. Utilisation acceptable</h2>
      <p>
        L&rsquo;utilisateur s&rsquo;engage à ne pas utiliser le service à des fins illicites, à ne pas tenter de contourner les mesures de sécurité ou
        d&rsquo;isolation des données entre établissements, et à ne pas utiliser le service pour transmettre du contenu illicite, trompeur ou portant
        atteinte aux droits de tiers, notamment via l&rsquo;intégration WhatsApp Business.
      </p>

      <h2>6. Disponibilité du service</h2>
      <p>
        Proactif Messaging s&rsquo;efforce d&rsquo;assurer un fonctionnement continu du service, sans toutefois garantir une disponibilité ininterrompue.
        Le service peut être temporairement interrompu pour des raisons de maintenance, de mise à jour, ou en cas de dysfonctionnement, y compris de
        services tiers dont Proactif Messaging dépend (notamment Meta/WhatsApp, Supabase, Render, OpenAI).
      </p>

      <h2>7. Propriété intellectuelle</h2>
      <p>
        Les contenus fournis par un établissement hôtelier (informations, photos, documents) restent sa propriété. Le logiciel, l&rsquo;interface et la
        marque Proactif Messaging / Proactif System restent la propriété de leur éditeur et ne peuvent être reproduits ou réutilisés sans autorisation.
      </p>

      <h2>8. Responsabilité</h2>
      <p>
        Dans les limites permises par la loi applicable, Proactif Messaging ne saurait être tenu responsable des dommages indirects résultant de
        l&rsquo;utilisation du service, ni des conséquences d&rsquo;une indisponibilité ou d&rsquo;un dysfonctionnement d&rsquo;un service tiers
        (notamment Meta/WhatsApp) sur lequel Proactif Messaging n&rsquo;a pas de contrôle direct.
      </p>

      <h2>9. Données personnelles</h2>
      <p>
        Le traitement des données personnelles dans le cadre de Proactif Messaging est décrit dans notre{" "}
        <a href="/politique-de-confidentialite" className="underline hover:text-ink">
          politique de confidentialité
        </a>
        . Les modalités de suppression des données sont décrites sur notre page{" "}
        <a href="/suppression-donnees" className="underline hover:text-ink">
          Suppression des données
        </a>
        .
      </p>

      <h2>10. Modification des présentes conditions</h2>
      <p>
        Les présentes conditions peuvent être mises à jour pour refléter l&rsquo;évolution du service. La date de dernière mise à jour figure en haut de
        cette page.
      </p>

      <h2>11. Droit applicable</h2>
      <p>Les présentes conditions sont soumises au droit français.</p>

      <h2>12. Contact</h2>
      <p>
        Pour toute question relative aux présentes conditions, vous pouvez nous contacter à l&rsquo;adresse suivante :{" "}
        <a href="mailto:sellindidier@gmail.com" className="underline hover:text-ink">
          sellindidier@gmail.com
        </a>
        .
      </p>
    </LegalLayout>
  );
}
