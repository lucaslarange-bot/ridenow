# RideNow 🚗 — VTC temps réel (type Uber)

Carte avec chauffeurs live, demande de course, acceptation chauffeur, suivi du trajet,
chat client↔chauffeur et estimation de prix.

## Architecture de déploiement
- **`web/`** → **Vercel** (front statique React + Leaflet, ton domaine)
- **`server/`** → **Railway** (serveur Node + Socket.io, WebSockets natifs)
- **GitHub** → un seul repo, déploiement auto à chaque `git push`

> Pourquoi pas 100% Vercel ? Vercel est serverless et ne garde pas de connexion
> WebSocket permanente. Le serveur temps réel Socket.io doit tourner ailleurs (Railway).

```
ridenow/
├── web/                # Front (Vercel)
│   ├── index.html
│   ├── app.jsx
│   ├── config.js       # généré au build depuis RIDENOW_BACKEND (ne pas éditer en prod)
│   ├── build.js        # script de build Vercel
│   └── vercel.json
├── server/             # Backend (Railway)
│   ├── server.js
│   ├── package.json
│   └── railway.json
├── .env.example
└── .gitignore
```

---

## 1) Mettre sur GitHub
```bash
cd ridenow
git init
git add .
git commit -m "RideNow : VTC temps réel"
git branch -M main
git remote add origin https://github.com/<ton-compte>/ridenow.git
git push -u origin main
```

## 2) Déployer le serveur sur Railway
1. https://railway.app → **New Project** → **Deploy from GitHub repo** → `ridenow`.
2. Réglages du service : **Root Directory = `server`**.
3. Railway détecte Node et lance `npm start` (le `PORT` est injecté automatiquement).
4. **Settings → Networking → Generate Domain** → copie l'URL, ex :
   `https://ridenow-production.up.railway.app`.

## 3) Déployer le front sur Vercel
1. https://vercel.com → **Add New → Project** → importe `ridenow`.
2. **Root Directory = `web`**, Framework Preset = **Other**.
   (Build Command et Output sont déjà dans `web/vercel.json`.)
3. **Settings → Environment Variables** → ajoute :
   | Name | Value |
   |------|-------|
   | `RIDENOW_BACKEND` | ton URL Railway (ex : `https://ridenow-production.up.railway.app`) |
4. **Deploy**. Le build lance `node build.js` qui écrit l'URL dans `config.js`.

C'est en ligne 🎉 — à chaque `git push`, Vercel et Railway se redéploient tout seuls.
Pour changer d'URL backend : modifie la variable `RIDENOW_BACKEND` dans Vercel et redeploy
(aucune ligne de code à toucher).

---

## Développement local
```bash
cd server
npm install
npm start
```
Ouvre **http://localhost:3000** (le serveur sert aussi le front ; `config.js` reste vide,
le front se connecte en même origine). Teste en deux onglets : un **Client**, un **Chauffeur**.

## Fonctions
- 🗺️ Chauffeurs positionnés qui bougent en temps réel (5 bots de démo inclus)
- 🧍 Client : départ/arrivée, prix + distance + durée, commande, suivi live
- 🚗 Chauffeur : online/offline, file de demandes, acceptation, statuts du trajet
- 💬 Chat bidirectionnel dès la course acceptée
- 💶 Tarif : 2,50 € + 1,20 €/km + 0,35 €/min (min. 6 €) — dans `server/server.js` (`PRICING`)

## Étapes vers la prod
- État mémoire → **PostgreSQL + Redis**
- Auth (JWT / OTP SMS), comptes client & chauffeur
- Géoloc continue + itinéraires (OSRM / Mapbox)
- Paiement : **Stripe Connect** (versements chauffeurs)
- Apps mobiles React Native (réutilise la logique Socket.io)
