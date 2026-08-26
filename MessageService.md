# MessageService

> Base URL: `https://message.freischule.info`

Verwaltet **Direktnachrichten (DMs)** zwischen eingeloggten Nutzern sowie **Channel-Nachrichten** (many-to-many, für den MessangerClient). Nachrichten werden in MongoDB gespeichert (TTL 180 Tage). Echtzeit-Benachrichtigungen via PresenceService. Ungelesene DMs können periodisch via EmailService versendet werden.

**Datenmodell DM (`Message`):**

| Feld | Typ | Description |
|------|-----|-------------|
| `senderId` | String | JWT `sub` des Absenders |
| `recipientId` | String | JWT `sub` des Empfängers |
| `body` | String | Nachrichtentext (max. 5.000 Zeichen) |
| `readAt` | Date | `null` = ungelesen |
| `createdAt` | Date | Auto-gesetzt; TTL-Index: 180 Tage |
| `deletedBySender` | Boolean | Soft-Delete-Flag für Absender |
| `deletedByRecipient` | Boolean | Soft-Delete-Flag für Empfänger |

**Datenmodell Channel (`ChannelMessage`):**

| Feld | Typ | Description |
|------|-----|-------------|
| `id` | String | Dokument-ID (serialisiert aus `_id`) |
| `senderId` | String | JWT `sub` des Autors |
| `channelId` | String | ObjectService-Channel-ID (ersetzt `recipientId`) |
| `body` | String | Nachrichtentext (max. 5.000 Zeichen); bei E2E-Channels Base64-Envelope `{ ciphertext, nonce, keyVersion }` — der Service sieht nur Ciphertext |
| `createdAt` | Date | Auto-gesetzt; TTL-Index: 180 Tage |

> Channels haben **kein** `readAt` und keine Soft-Delete-Flags (many-to-many; Read-Receipts out of scope).

**Channel-Zugriffskontrolle (Mitglieds-only):** Jeder Zugriff auf `/channels/...` wird gegen die Channel-Mitgliedschaft autorisiert — der JWT-`sub` muss in `memberIds` des Channels enthalten sein. Die Mitgliedschaft wird beim **ObjectService** (`channels`-Collection, `data.memberIds`) per `X-API-Key` abgerufen und kurz gecacht (`CHANNEL_MEMBERSHIP_TTL_MS`, default 10s; `0` deaktiviert den Cache für sofortigen Entzug). Nicht-Mitglieder erhalten `403`, unbekannte Channels `404` — weder Inhalt noch Metadaten gelangen an Nicht-Mitglieder.

**Auth-Varianten:**
- **JWT** — Bearer Token; für alle Nutzer-Endpunkte
- **JWT Admin** — gültiges JWT mit Rolle `admin`

---

## Public

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/` | — | Hello World |
| `GET` | `/health` | — | Health check — `{ status: "ok", service: "MessageService" }` |

---

## User (Bearer JWT)

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/messages` | `recipientId`*, `body`* | Nachricht senden |
| `GET` | `/messages/unread-count` | — | `{ count }` — Anzahl ungelesener Nachrichten |
| `GET` | `/messages/inbox` | `?page&limit&unreadOnly` | Empfangene Nachrichten, neueste zuerst (default limit 20, max 100) |
| `GET` | `/messages/sent` | `?page&limit` | Gesendete Nachrichten (default limit 20, max 100) |
| `GET` | `/messages/conversation/:userId` | `?page&limit` | Alle Nachrichten mit einem bestimmten Nutzer (beide Richtungen), chronologisch |
| `PATCH` | `/messages/:id/read` | — | Einzelne Nachricht als gelesen markieren (nur Empfänger) |
| `PATCH` | `/messages/read-all` | `{ senderId* }` | Alle Nachrichten eines Absenders als gelesen markieren |
| `DELETE` | `/messages/:id` | — | Eigene Nachricht soft-löschen (Absender oder Empfänger); hard-delete wenn beide Flags gesetzt |

---

## Channels (Bearer JWT, **Mitglieds-only**)

> Zugriff nur für Channel-Mitglieder (`sub` ∈ `memberIds`). Ungültige `channelId` → `400`, Nicht-Mitglieder → `403`, unbekannte Channels → `404`.

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| `POST` | `/channels/:channelId/messages` | `{ body* }` | Channel-Nachricht senden → `201` `ServiceMessage` |
| `GET` | `/channels/:channelId/messages` | `?page&limit` | Channel-Nachrichten, neueste zuerst (default page 1, limit 100, max 100) → `200` `{ total, page, limit, data: ServiceMessage[] }` |

---

## Channel-Mitgliedschaft verwalten (Bearer JWT)

> **Berechtigung:** *ChannelAdmin* (`sub` ∈ `data.adminIds` **oder** `sub == createdBy`) **oder** *Service-Admin* (JWT-Rolle `admin`). Service-Admins dürfen verwalten, ohne Mitglied zu sein — erhalten dadurch aber **kein** Leserecht auf Nachrichten. Self-Leave (sich selbst entfernen) ist für jedes Mitglied erlaubt.
>
> Admins müssen **nicht** Mitglied sein (ein Nicht-Mitglied kann ChannelAdmin sein, kann dann aber nicht mitlesen). Der Ersteller (`createdBy`) ist permanenter Admin und kann **nicht** entfernt oder degradiert werden (`409`).

| Method | Endpoint | Body | Auth | Description |
|--------|----------|------|------|-------------|
| `GET` | `/channels/:channelId/members` | — | Mitglied / ChannelAdmin / Service-Admin | `{ memberIds, adminIds }` |
| `POST` | `/channels/:channelId/members` | `{ userId* }` | ChannelAdmin / Service-Admin | Mitglied hinzufügen (idempotent) → `{ memberIds, adminIds }` |
| `DELETE` | `/channels/:channelId/members/:userId` | — | ChannelAdmin / Service-Admin / Self | Mitglied entfernen / verlassen → `{ memberIds, adminIds }` |
| `POST` | `/channels/:channelId/admins` | `{ userId* }` | ChannelAdmin / Service-Admin | Zum ChannelAdmin ernennen (idempotent) → `{ memberIds, adminIds }` |
| `DELETE` | `/channels/:channelId/admins/:userId` | — | ChannelAdmin / Service-Admin | ChannelAdmin degradieren → `{ memberIds, adminIds }` |

Fehlercodes: `400` ungültige `channelId`/`userId`, `403` nicht berechtigt, `404` unbekannter Channel, `409` Ersteller kann nicht entfernt/degradiert werden. Mitgliedschaft wird im ObjectService (`channels`, `data.memberIds`/`data.adminIds`) per `X-API-Key` (PATCH `merge:true`) geschrieben; der lokale Membership-Cache wird nach jedem Write invalidiert.

---

## Admin (JWT mit Rolle `admin`)

| Method | Endpoint | Query | Description |
|--------|----------|-------|-------------|
| `GET` | `/admin/messages` | `?senderId&recipientId&page&limit` | Alle Nachrichten mit optionalen Filtern auflisten |
| `DELETE` | `/admin/messages/:id` | — | Beliebige Nachricht löschen |
| `POST` | `/refresh-key` | — | Gecachten JWT Public Key force-refreshen |
