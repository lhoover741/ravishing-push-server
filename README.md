# Ravishing Beauté Push Server

Production-ready Railway push notification server for the Ravishing Beauté PWA.

## Features

- Encrypted Web Push notifications
- iPhone Safari compatible
- Android + desktop compatible
- Railway-ready
- PostgreSQL subscription storage
- Automatic cleanup of expired subscriptions

## Environment Variables

Create these in Railway:

```env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:bookings@ravishingbeaute.salon
DATABASE_URL=
```

## Start

```bash
npm install
npm start
```

## Routes

### GET /

Health check.

### GET /vapid-public-key

Returns public VAPID key.

### POST /subscribe

Stores browser subscription.

### POST /send

Sends push notification.

Example:

```bash
curl -X POST https://YOUR-RAILWAY-URL.up.railway.app/send \
-H "Content-Type: application/json" \
-d '{
  "title":"Ravishing Beauté",
  "body":"Appointment confirmed 💅"
}'
```

## Frontend Example

```js
const vapid = await fetch("https://YOUR-RAILWAY-URL.up.railway.app/vapid-public-key")
  .then(r => r.json());
```
