# Vestel EVC04 Home – intégration Gladys Assistant

Cette intégration communautaire connecte une borne Vestel EVC04 Home à [Gladys Assistant](https://gladysassistant.com/) via **Modbus TCP**. Elle lit les mesures de charge et contrôle localement le courant de charge autorisé. Elle ne nécessite ni cloud du fabricant, ni serveur OCPP, ni compte utilisateur.

## Prérequis

- Gladys Assistant **5.1.0 ou version ultérieure**.
- Modbus TCP activé sur la borne.
- La borne et l'hôte Gladys doivent être accessibles sur le même réseau.
- Port Modbus TCP par défaut : **502**. Unit ID par défaut : **255**.

L'EVC04 n'accepte qu'**un seul maître Modbus à la fois**. Cette intégration utilise une connexion unique pour les mesures, les tests de connexion et les commandes. Ne connectez pas un autre client Modbus à la borne en parallèle.

## Installation et configuration

Installez l'intégration depuis le système d'intégrations de Gladys. L'image du conteneur est publiée à l'adresse suivante :

`ghcr.io/tomgermany/gladys-vestel-evc04:latest`

Configurez l'adresse IP ou le nom mDNS de la borne (sans `http://`), le port Modbus, l'Unit ID, l'intervalle de lecture des mesures et le délai du heartbeat. Une réservation DHCP est recommandée afin de conserver une adresse stable.

| Paramètre | Valeur par défaut | Description |
| --- | --- | --- |
| Adresse de la borne | — | Adresse IP ou nom mDNS |
| Port Modbus | `502` | À modifier uniquement si la borne utilise un autre port |
| Unit ID Modbus | `255` | Unit ID par défaut de l'EVC04 |
| Intervalle de lecture | 5 minutes | Valeurs disponibles : 1, 5, 15, 30 ou 60 minutes |
| Délai du heartbeat | 20 secondes | Utilisé lorsque le contrôle du courant est actif |

Après avoir enregistré la configuration, utilisez **Vérifier la connexion** pour tester la communication via la connexion existante.

## Mesures et actualisation

L'intégration transmet à Gladys l'état de charge, la puissance, le courant, la tension et l'énergie. L'intervalle choisi détermine la fréquence d'actualisation de ces mesures. En cas d'échec de lecture, l'erreur est enregistrée et l'intégration tente une reconnexion avec un nouveau socket. Avec un intervalle de cinq minutes, un problème de connexion peut attendre la prochaine lecture programmée avant d'être détecté par le polling normal.

## Contrôle du courant de charge et heartbeat

L'intégration règle le courant autorisé via le registre Modbus `5004`. La borne ne dispose pas d'une commande distincte de démarrage/arrêt : la charge commence ou s'arrête selon que le véhicule consomme du courant.

- Le courant demandé est limité à **6 A minimum** et au maximum autorisé par la borne et le câble.
- Le widget du tableau de bord permet d'augmenter ou de diminuer le courant, par pas de **1, 2 ou 5 A** configurables pour chaque widget.
- Les scènes Gladys peuvent définir une valeur avec l'action **Définir le courant de charge**.
- Tant que le contrôle du courant est maintenu, l'intégration envoie un heartbeat via le registre `6000`. Avec le délai par défaut de 20 secondes, l'envoi a lieu environ toutes les 10 secondes, avec un intervalle minimal de 3 secondes.
- Si le heartbeat s'arrête, la borne revient à son courant de sécurité. Ce mécanisme est indépendant de l'intervalle de lecture et ne peut pas redémarrer une borne dont le firmware est bloqué.

## Scènes Gladys

Deux événements sont disponibles :

- **La borne charge** — déclenché lors du passage à l'état de charge.
- **Fin de charge de la borne** — déclenché lors de la sortie de cet état.

Selon l'événement, des variables telles que la puissance, le courant de charge, l'index du compteur, l'énergie de la session et sa durée sont disponibles. Une scène peut également utiliser l'action **Définir le courant de charge**.

## Dépannage

- **Aucune réponse :** vérifiez l'adresse de la borne, le réseau et l'activation de Modbus TCP.
- **Unit ID incorrect :** la valeur par défaut est `255`, et non `1`.
- **Connexion occupée :** assurez-vous qu'aucun autre client Modbus n'est connecté à l'EVC04.
- **Mesures anciennes :** vérifiez l'intervalle de lecture ou lancez **Vérifier la connexion**.
- **Borne bloquée :** le heartbeat peut déclencher le courant de sécurité, mais l'intégration ne peut pas couper puis rétablir l'alimentation ni réparer un blocage du firmware.

## Marques et fabricant

Il s'agit d'une intégration communautaire indépendante pour Gladys Assistant. Elle n'est ni développée, ni approuvée, ni officiellement prise en charge par Vestel. **Vestel** et **EVC04** sont des désignations du fabricant. Les marques, logos et représentations de produits appartiennent à leurs propriétaires respectifs et servent uniquement à identifier le produit pris en charge.

## Licence

Apache-2.0.
