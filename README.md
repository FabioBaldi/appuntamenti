# Gestione Appuntamenti

Piattaforma web standalone per la gestione completa degli appuntamenti con:

- accesso tramite `username` e `password`
- ruoli `admin` e `user`
- creazione utenti consentita solo agli admin
- logo assegnabile solo dall'admin principale ai rami `admin`, ereditato dagli utenti creati in quel ramo
- agenda appuntamenti con stato, assegnazione e note
- persistenza dati su `Supabase`
- reminder automatici o manuali via `email`, `SMS` o `WhatsApp`
- possibilita per ogni ramo `admin` di usare il WhatsApp del cliente con billing diretto su Meta, mantenendo il fallback al provider attuale
- wallet per ramo con ricarica via `Stripe Checkout` e storico movimenti

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
- `public.admin_channel_configs`
- `public.appointments`
- `public.wallet_transactions`

Il cookie di login e firmato dal server, mentre utenti e appuntamenti risiedono in Supabase.

Se stai aggiornando una versione gia avviata del progetto, riesegui [supabase/schema.sql](./supabase/schema.sql) oppure applica le migration in `supabase/migrations`, cosi aggiungi anche wallet, movimenti e funzioni RPC necessarie.

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

### SMS e fallback WhatsApp della piattaforma

Provider supportato: `Twilio`

```env
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_FROM=+39...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

### WhatsApp del cliente

Ogni `admin` proprietario di ramo puo scegliere, dalla tab `Reminder`, fra due modalita:

- `Provider attuale della piattaforma`: mantiene la configurazione centrale esistente
- `Meta Cloud API del cliente`: usa il `Phone Number ID` e il token Meta del cliente, cosi il costo dei messaggi WhatsApp resta sul suo account Meta

Il cambio e reversibile in qualsiasi momento: basta riportare il ramo su `Provider attuale della piattaforma`.

Variabili utili:

```env
APP_CREDENTIALS_SECRET=una-chiave-lunga-per-cifrare-i-token-meta
META_GRAPH_VERSION=v23.0
```

Se `APP_CREDENTIALS_SECRET` non e impostata, il server usa `SESSION_SECRET` per cifrare i token salvati.

### Wallet e Stripe

Il ramo puo essere configurato in due modi:

- `platform`: il costo di SMS e WhatsApp resta a carico della piattaforma
- `wallet`: ogni invio reale scala il saldo del ramo

Il wallet usa `Stripe Checkout` per le ricariche e un webhook firmato per accreditare il credito solo a pagamento confermato.

Variabili da impostare:

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_WALLET_CURRENCY=EUR
STRIPE_WALLET_MIN_TOPUP=10
STRIPE_WALLET_MAX_TOPUP=1000
STRIPE_WALLET_TOPUP_OPTIONS=25,50,100
```

Webhook da registrare su Stripe:

- `POST /api/stripe/webhook`

Evento richiesto:

- `checkout.session.completed`

Comportamento attuale:

- gli admin di ramo possono ricaricare il proprio wallet
- solo l'admin principale puo decidere se un ramo usa `platform` o `wallet`
- solo gli invii reali consumano credito; la modalita `mock` non scala il saldo

### Modalita mock

Se i provider non sono configurati e `ALLOW_MOCK_DELIVERY=true`, il sistema non salva log locali: i risultati dei reminder restano associati all'appuntamento in Supabase e la consegna viene simulata dal server.

## Permessi

- `admin`: puo creare utenti, vedere tutti gli appuntamenti e assegnarli
- `user`: puo gestire i propri appuntamenti
