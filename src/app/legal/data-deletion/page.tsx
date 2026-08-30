// Public, unauthenticated legal page (no session, no cookie required — see
// updateSession.ts's own PUBLIC_PATH_PREFIXES). Written to be usable
// directly as Meta's own "Data Deletion Instructions URL" for the
// Proactif Messaging app (Meta Embedded Signup / WhatsApp Business
// integration) — it explains a real, followable process rather than
// offering an automated self-service delete button, which is explicitly
// an accepted form of "data deletion instructions" under Meta's own
// requirements.
import { LegalLayout } from "../LegalLayout";

const UPDATED_AT = "29 août 2026";

export const metadata = {
  title: "Suppression de vos données — Proactif Messaging",
};

export default function DataDeletionPage() {
  return (
    <LegalLayout title="Suppression de vos données — Proactif Messaging" updatedAt={UPDATED_AT}>
      <p>
        Cette page explique comment demander la suppression des données personnelles traitées par <strong>Proactif Messaging</strong>, que vous soyez
        un établissement hôtelier client, un client d&rsquo;un hôtel ayant échangé avec l&rsquo;assistant, ou un partenaire référencé par un hôtel. Pour
        le détail des données concernées, consultez notre{" "}
        <a href="/politique-de-confidentialite" className="underline hover:text-ink">
          politique de confidentialité
        </a>.
      </p>

      <h2>1. Comment demander une suppression</h2>
      <p>
        Une demande de suppression doit nous être adressée par écrit, à l&rsquo;adresse suivante :{" "}
        <a href="mailto:sellindidier@gmail.com" className="underline hover:text-ink">
          sellindidier@gmail.com
        </a>.
      </p>

      <h2>2. Informations à nous fournir</h2>
      <p>Pour identifier avec certitude le compte ou les données concernées, merci d&rsquo;indiquer dans votre demande :</p>
      <ul>
        <li>le nom de l&rsquo;établissement hôtelier concerné, si votre demande porte sur un compte professionnel ;</li>
        <li>l&rsquo;adresse email associée au compte, le cas échéant ;</li>
        <li>si votre demande concerne une connexion WhatsApp Business, le nom de l&rsquo;établissement ayant réalisé la connexion ;</li>
        <li>si votre demande concerne une conversation avec l&rsquo;assistant d&rsquo;un hôtel, la date approximative et l&rsquo;établissement
          concerné.</li>
      </ul>

      <h2>3. Vérification d&rsquo;identité</h2>
      <p>
        Afin d&rsquo;éviter qu&rsquo;une personne non autorisée ne demande la suppression de données qui ne lui appartiennent pas, nous pouvons vous
        demander de confirmer votre identité ou votre qualité (par exemple, votre rôle au sein de l&rsquo;établissement hôtelier concerné) avant de
        traiter votre demande.
      </p>

      <h2>4. Ce qui est supprimé</h2>
      <p>
        Selon votre demande, la suppression peut porter sur les données de votre compte, le contenu des conversations associées, les données de contact
        transmises dans le cadre d&rsquo;une demande partenaire, ou la connexion WhatsApp Business d&rsquo;un établissement.
      </p>
      <p>
        Pour une connexion WhatsApp Business : la déconnexion entraîne la révocation et la suppression de l&rsquo;identifiant d&rsquo;accès chiffré
        associé à cette connexion, ainsi que des identifiants techniques (WABA ID, Phone Number ID, Business ID) qui lui sont liés. Cette suppression
        ne concerne que les données conservées par Proactif Messaging ; elle ne modifie pas les paramètres propres au compte Meta ou WhatsApp Business
        de l&rsquo;hôtel lui-même, qui restent gérés directement par l&rsquo;hôtel dans son espace Meta.
      </p>

      <h2>5. Données pouvant être conservées malgré une demande de suppression</h2>
      <p>
        Certaines données peuvent être conservées au-delà d&rsquo;une demande de suppression lorsqu&rsquo;une obligation légale nous impose de le faire,
        ou le temps nécessaire à la constatation, l&rsquo;exercice ou la défense de droits en cas de litige. Dans ce cas, nous vous en informons.
      </p>

      <h2>6. Délai de traitement</h2>
      <p>
        Nous traitons les demandes relatives à vos droits, y compris les demandes de suppression, dans le délai prévu par la réglementation applicable
        en matière de protection des données, à savoir un délai d&rsquo;un mois à compter de la réception de votre demande, pouvant être porté à trois
        mois pour les demandes complexes, auquel cas nous vous en informons dans le délai initial.
      </p>

      <h2>7. Réclamation</h2>
      <p>
        Si vous n&rsquo;obtenez pas de réponse satisfaisante, vous pouvez adresser une réclamation à la Commission Nationale de l&rsquo;Informatique et
        des Libertés (CNIL) : <span className="whitespace-nowrap">www.cnil.fr</span>.
      </p>
    </LegalLayout>
  );
}
