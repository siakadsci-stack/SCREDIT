# S crédits

Application web mobile (PWA) pour suivre les crédits clients : montant dû, versements, reste à payer, pièce d'identité, rappel de recouvrement avec alerte, et licence d'utilisation gérée par un administrateur.

Tout est en HTML, CSS et JavaScript simples, sans installation de bibliothèque. Les données restent sur l'appareil (IndexedDB).

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `style.css` | Styles, thème clair et sombre |
| `app.js` | Logique : crédits, alertes, licence, espace administrateur |
| `store.js` | Stockage local (IndexedDB). C'est le seul fichier à remplacer pour passer à un serveur |
| `manifest.json`, `sw.js` | Installation sur téléphone et mode hors ligne |
| `icons/` | Icône de l'application et logo utilisé dans la page |
| `logos/` | Logos prêts à l'emploi (S seul, S au-dessus de « crédits », icône 512) |

## Lancer dans VS Code

1. Ouvrez le dossier `s-credits` dans VS Code.
2. Installez l'extension **Live Server** (Ritwick Dey), puis clic droit sur `index.html` et **Open with Live Server**.
3. L'application s'ouvre sur `http://127.0.0.1:5500`.

Ne double-cliquez pas sur `index.html` : le mode hors ligne ne marche pas avec une adresse `file://`.

## Première ouverture

L'application est verrouillée tant qu'aucune licence n'est activée.
1. Touchez **Espace administrateur**.
2. Saisissez le code par défaut **DS2506**.
3. Ajoutez par exemple 30 jours. L'application s'ouvre.

Changez ensuite le code dans la même fenêtre (« Code administrateur »).

## Mettre en ligne (gratuit) pour l'installer sur un téléphone

Il faut une adresse en `https://`.
- **Netlify** : allez sur app.netlify.com/drop et glissez le dossier `s-credits`. Vous obtenez un lien.
- **GitHub Pages** : déposez les fichiers dans un dépôt, puis Settings, Pages.

Sur le téléphone, ouvrez le lien :
- **Android (Chrome)** : menu ⋮, puis « Installer l'application » ou « Ajouter à l'écran d'accueil ».
- **iPhone (Safari)** : bouton Partager, puis « Sur l'écran d'accueil ».

Après une mise à jour des fichiers, changez le numéro de version `CACHE` au début de `sw.js` pour que les téléphones rechargent la nouvelle version.

## Limites à connaître

- **La licence est enregistrée sur l'appareil.** Quelqu'un qui sait manipuler les outils du navigateur, ou qui change l'heure du téléphone, peut la contourner. Effacer les données du navigateur efface aussi les crédits et remet l'application en « licence non activée ».
- **Les alertes** s'affichent à l'ouverture de l'application et pendant qu'elle reste ouverte. Sans serveur, le téléphone ne peut pas envoyer de notification quand elle est fermée.
- **Les photos de pièces d'identité** sont des données personnelles : elles restent sur l'appareil, sans chiffrement. Protégez le téléphone par un code.
- **Sauvegarde** : il n'y a pas d'export dans cette version. Si le téléphone est perdu ou réinitialisé, les données le sont aussi.

## Pour aller plus loin

Une licence qui ne peut pas être contournée, des crédits accessibles depuis plusieurs téléphones et de vraies notifications demandent un serveur (par exemple Firebase : authentification, Firestore avec règles de sécurité, Cloud Messaging). `app.js` n'utilise que l'interface de `store.js` (`doc`, `collection`, `get`, `set`, `delete`, `onSnapshot`) : remplacer ce fichier suffit pour brancher un autre stockage.
