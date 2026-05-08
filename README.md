# Gestione Appuntamenti

Piattaforma web standalone per la gestione completa degli appuntamenti con:

- accesso tramite `username` e `password`
- ruoli `admin` e `user`
- creazione utenti consentita solo agli admin
- logo assegnabile solo dall'admin principale ai rami `admin`, ereditato dagli utenti creati in quel ramo
- agenda appuntamenti con stato, assegnazione e note
- persistenza dati su `Supabase`
- reminder automatici o manuali via `email`, `SMS` o `WhatsApp`

## Avvio rapido

1. Crea un progetto Supabase.
2. Apri il SQL Editor di Supabase ed esegui [supabase/schema.sql](./supabase/schema.sql).
3. Copia `.env.example` in `.env`.
4. Compila almeno queste variabili:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY` oppure `SUPABASE_SERVICE_ROLE_KEY`
   - `SESSION_SECRET`
5. Se vuoi cambiare credenziali iniziali, modifica:
   - `INITIAL_ADMIN_USERNAME`
   - `INITIAL_ADMIN_PASSWORD`
   - `INITIAL_ADMIN_NAME`
6. Avvia il progetto:

```bash
npm start
```

7. Apri [http://localhost:3000](http://localhost:3000)

Se la tabella utenti e vuota, il server crea automaticamente un admin iniziale:

- username: `admin`
- password: `Admin123!`

## Storage Supabase

Il backend usa le API REST di Supabase lato server. Nessun utente o appuntamento viene salvato in locale.

Tabelle utilizzate:

- `public.app_users`
- `public.appointments`

Il cookie di login e firmato dal server, mentre utenti e appuntamenti risiedono in Supabase.

Se stai aggiornando una versione gia avviata del progetto, riesegui [supabase/schema.sql](./supabase/schema.sql) per aggiungere i campi `is_platform_owner`, `created_by_user_id`, `owner_admin_id` e `logo_data_url`.

## Reminder multicanale

Il sistema supporta due modalita:

- `live`: invio reale tramite provider esterni
- `mock`: simulazione locale utile per test e demo

### Email

Provider supportato: `Resend`

```env
RESEND_API_KEY=...
RESEND_FROM_EMAIL=Appuntamenti <noreply@example.com>
```

### SMS e WhatsApp

Provider supportato: `Twilio`

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_FROM=+39...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

### Modalita mock

Se i provider non sono configurati e `ALLOW_MOCK_DELIVERY=true`, il sistema non salva log locali: i risultati dei reminder restano associati all'appuntamento in Supabase e la consegna viene simulata dal server.

## Permessi

- `admin`: puo creare utenti, vedere tutti gli appuntamenti e assegnarli
- `user`: puo gestire i propri appuntamenti
