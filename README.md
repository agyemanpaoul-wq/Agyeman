# Agyeman: istruzioni di installazione

Agyeman è una web app installabile sull'iPhone come icona nella schermata Home. Funziona così:
- Garmin Connect fornisce sonno, HRV, FC a riposo, Body Battery, allenamenti, VO2max e carico;
- Outlook (Microsoft 365 di Crico) fornisce posta, calendario e To Do;
- Supabase è il database privato dove finisce tutto, accessibile solo con la tua email;
- GitHub esegue le sincronizzazioni automatiche e pubblica l'app;
- Claude (API Anthropic) fa da coach, briefing, analisi pasti da foto, lettura avvisi pagoPA e classificazione delle email.

Servono: un computer con browser (va bene Windows), circa 2 ore, i diritti di amministratore Microsoft 365 di Crico.
Costi: GitHub, Supabase e Microsoft gratis nei piani base; API Anthropic a consumo (imposta un limite mensile).

Contenuto del pacchetto:
- `docs/` l'app (index.html, config.js, icone);
- `sync/` script Garmin;
- `supabase/setup.sql` il database completo;
- `supabase/functions/` le 4 funzioni server: `claude`, `ms-auth`, `ms-sync`, `ms-action`;
- `.github/workflows/` le sincronizzazioni automatiche (Garmin e Outlook).

Durante l'installazione annota in un file di testo questi valori, servono in più passaggi:
URL Supabase, chiave publishable, chiave secret, chiave Anthropic, ID client, ID tenant e segreto Microsoft, SYNC_TOKEN, indirizzo dell'app.

---

## Fase 1. GitHub (15 minuti)

1. Crea un account su github.com.
2. In alto a destra "+" > New repository. Nome `agyeman`, visibilità Public (serve per pubblicare l'app gratis;
   il codice non contiene dati né chiavi), spunta "Add a README file", Create repository.
3. Nel repository: Add file > Upload files. Trascina le cartelle `docs`, `sync`, `supabase` e il file README.md. Commit changes.
4. La cartella `.github` di solito non si carica perché è nascosta. Creala a mano, due volte:
   Add file > Create new file, nome `.github/workflows/sync.yml`, incolla il contenuto del file omonimo, Commit;
   poi lo stesso per `.github/workflows/outlook.yml`.

Controllo: nel repository vedi le cartelle `.github`, `docs`, `supabase`, `sync`.

## Fase 2. Supabase, il database (15 minuti)

1. supabase.com > Start your project > accedi con GitHub.
2. New project: nome `agyeman`, password del database (conservala), Region: Central EU (Frankfurt). Attendi la creazione.
3. Apri `supabase/setup.sql`, sostituisci `TUA_EMAIL@ESEMPIO.IT` con la tua email (una sola riga).
   In Supabase: SQL Editor > New query > incolla tutto > Run. Deve rispondere "Success".
4. Authentication > Users > Add user > Create new user: la stessa email, una password qualsiasi, conferma automatica.
5. Authentication > Sign In / Providers: disattiva "Allow new users to sign up". Nessun altro potrà registrarsi.
6. Project Settings > API Keys: annota Project URL, chiave publishable (`sb_publishable_...`, oppure la legacy `anon`)
   e chiave secret (`sb_secret_...`, oppure la legacy `service_role`). La secret non va mai nell'app.

Controllo: Table Editor mostra le tabelle daily, activities, meals, tasks, bills, events, emails e le altre.

## Fase 3. Collegamento Garmin (15 minuti)

1. Nel repository GitHub: pulsante verde Code > scheda Codespaces > Create codespace on main.
2. Nel terminale in basso:
   ```
   pip install -r sync/requirements.txt
   python sync/garmin_login.py
   ```
   Email e password Garmin, poi il codice MFA se richiesto. Lo script stampa una lunga riga JSON: copiala tutta.
3. Chiudi il Codespace: Code > Codespaces > ... > Delete.
4. Repository > Settings > Secrets and variables > Actions > New repository secret. Crea:
   - `GARMIN_TOKENS` = la riga JSON;
   - `SUPABASE_URL` = Project URL;
   - `SUPABASE_SECRET_KEY` = chiave secret.
5. Actions > (abilita i workflow se richiesto) > Sync Garmin > Run workflow > days `60` > Run workflow.

Controllo: dopo 2-3 minuti l'esecuzione è verde e in Supabase la tabella daily contiene i tuoi giorni.
Se è rossa: apri l'esecuzione, copia il log e mandamelo.

## Fase 4. Claude (10 minuti)

1. console.anthropic.com: crea l'account, Billing > aggiungi carta e un credito iniziale,
   Limits > imposta un limite di spesa mensile. API Keys > Create Key: copia la chiave `sk-ant-...`.
2. Supabase > Edge Functions > Secrets: aggiungi `ANTHROPIC_API_KEY` con la chiave.
3. Edge Functions > Deploy a new function > Via Editor. Nome esatto `claude`, incolla `supabase/functions/claude/index.ts`,
   Verify JWT attivo, Deploy.

## Fase 5. Microsoft 365 / Outlook (25 minuti, serve l'amministratore del tenant)

Prima una decisione: con questa fase il testo delle email di lavoro nuove viene inviato ad Anthropic per la classificazione.
Su Supabase restano mittente, oggetto, anteprima, sintesi e azioni. Crico è titolare dei dati dei clienti:
verifica gli accordi sul trattamento dei dati (DPA) con Anthropic e Supabase. Puoi saltare questa fase e farla dopo:
il resto dell'app funziona lo stesso.

1. entra.microsoft.com > Applicazioni > Registrazioni app > Nuova registrazione.
   Nome `Agyeman`, account solo in questa directory organizzativa,
   URI di reindirizzamento tipo Web: `https://IL-TUO-PROGETTO.supabase.co/functions/v1/ms-auth`.
2. Panoramica: annota ID applicazione (client) e ID directory (tenant).
3. Certificati e segreti > Nuovo segreto client > copia subito il Valore. Annota la data di scadenza.
4. Autorizzazioni API > Aggiungi > Microsoft Graph > Autorizzazioni delegate:
   `offline_access`, `User.Read`, `Mail.Read`, `Calendars.ReadWrite`, `Tasks.ReadWrite` > Concedi consenso amministratore.
5. Supabase > Edge Functions > Secrets, aggiungi:
   - `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_CLIENT_SECRET`;
   - `APP_URL` = indirizzo dell'app (lo ottieni nella Fase 6, puoi tornare a inserirlo dopo);
   - `SYNC_TOKEN` = una stringa casuale lunga (ad esempio 40 caratteri tra lettere e numeri).
6. Deploy delle funzioni, Via Editor, nome esatto:
   - `ms-auth` con Verify JWT DISATTIVATO;
   - `ms-sync` con Verify JWT DISATTIVATO;
   - `ms-action` con Verify JWT attivo.
7. GitHub > Settings > Secrets > Actions: aggiungi `SYNC_TOKEN` con lo stesso valore.

## Fase 6. Pubblicazione e installazione sull'iPhone (15 minuti)

1. GitHub: apri `docs/config.js` > matita > inserisci Project URL e chiave publishable > Commit.
2. Settings > Pages > Source: Deploy from a branch > Branch `main`, cartella `/docs` > Save.
   Dopo un minuto compare l'indirizzo, tipo `https://tuonome.github.io/agyeman/`. Inseriscilo come `APP_URL` (Fase 5).
3. Supabase > Authentication > URL Configuration: Site URL = indirizzo dell'app, aggiungilo anche in Redirect URLs.
4. Sull'iPhone apri l'indirizzo in Safari, inserisci la tua email, apri il link ricevuto per email sullo stesso iPhone.
5. Condividi > Aggiungi alla schermata Home. Da qui in poi apri Agyeman dall'icona.
6. Work > Collega Outlook > login Microsoft > consenso. Torni in Agyeman già collegato.
7. GitHub > Actions > Sync Outlook > Run workflow per il primo caricamento. Poi gira da solo ogni 30 minuti dalle 6 alle 22.
8. Per le notifiche di task e appuntamenti: installa Microsoft To Do sull'iPhone e aggiungi l'account Outlook all'app Calendario.

## Aggiornamenti successivi del database

Quando ricevi una nuova versione del pacchetto, riesegui `supabase/setup.sql` (con la tua email): è scritto in modo da
aggiungere le tabelle nuove senza toccare i dati esistenti. Poi sostituisci su GitHub i file cambiati e rideploya
le funzioni modificate.

## Corpo e analisi

- Peso e composizione arrivano da soli con una bilancia Garmin Index; in alternativa li inserisci a mano o carichi
  un referto di bioimpedenza o DEXA. Metodi diversi danno numeri diversi: confronta nel tempo misure dello stesso tipo.
- Le analisi del sangue si caricano come foto o PDF: Claude estrae valori, unità e intervalli di riferimento, tu li
  confronti con il referto e salvi. Anche questi sono dati sanitari che passano dall'API di Anthropic e restano su Supabase.

## Schede e piani dei professionisti

- Wellness > Sport > Carica la scheda: foto o PDF della scheda del trainer. Viene trascritta senza modifiche;
  ogni giorno vedi la seduta prevista, la settimana con sedute fatte, saltate e previste, e l'aderenza.
- Wellness > Pasti > Carica il piano del nutrizionista: stesso principio; gli obiettivi del giorno arrivano dal piano.
- Dai PDF vengono lette le prime 4 pagine: per documenti più lunghi carica un PDF con le sole pagine del programma.
- Controlla sempre la trascrizione con l'originale prima di seguirla.

## Controllo finale

- Giornata: recovery, briefing (tocca Genera), priorità, timeline.
- Wellness > Oggi: quadrante recovery e metriche con le curve a 14 giorni.
- Wellness > Sport: stato di forma, volume, previsioni, attività con frazioni.
- Wellness > Pasti: crea il piano alimentare, fotografa un pasto e salvalo.
- Wellness > Corpo: andamento di peso, massa grassa e magra; carica un referto di analisi.
- Work: posta classificata, impegni e task di lavoro.
- Life: scansiona un avviso pagoPA, bollette, impegni privati.
- Coach: fai una domanda e chiedi di creare un task; deve comparire anche in Microsoft To Do.

## Manutenzione

- Sync Garmin rosso: i token sono scaduti o Garmin ha cambiato il login. Rifai la Fase 3, punti 1-4; se persiste mandami il log.
- Sync Outlook rosso: probabilmente è scaduto il segreto client Microsoft. Creane uno nuovo (Fase 5, punto 3) e aggiorna `MS_CLIENT_SECRET`.
- GitHub disattiva i workflow pianificati dopo 60 giorni senza modifiche al repository: arriva un'email, li riattivi da Actions.
- Supabase gratuito mette in pausa i progetti inattivi: le sincronizzazioni quotidiane lo tengono attivo.
- Costi Claude: controlla Usage nella console Anthropic dopo la prima settimana.

## Limiti noti

- La libreria Garmin non è ufficiale: può smettere di funzionare quando Garmin cambia qualcosa.
- Posta e calendario arrivano con un ritardo fino a 30 minuti.
- Le stime dei pasti da foto hanno un errore tipico del 20-30%.
- pagoPA non accetta link con l'avviso già compilato: Agyeman copia il codice avviso e apre il checkout.
- Gli appuntamenti Outlook vengono classificati Work o Life per parole chiave (allenamento, famiglia, medico...):
  il resto va in Work. La lista è in `supabase/functions/ms-sync/index.ts`, riga LIFE_RE.
