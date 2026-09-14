# Cron fidélisation

La V1 expose `POST /api/cron/loyalty`. L'appel doit inclure :

`Authorization: Bearer <LOYALTY_CRON_SECRET>`

Configurer `LOYALTY_CRON_SECRET` avec une valeur longue et aléatoire dans l'environnement d'hébergement. Aucun ordonnanceur n'est configuré par ce dépôt. Une cadence de 5 à 15 minutes convient. Les clés d'idempotence de `loyalty_deliveries` empêchent un second envoi lors d'une nouvelle exécution.

