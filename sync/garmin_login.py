"""Login Garmin una tantum. Da eseguire in GitHub Codespaces (o su un PC).
Stampa il contenuto da incollare nel secret GitHub GARMIN_TOKENS."""
import getpass
import json
import pathlib

from garminconnect import Garmin

store = pathlib.Path("~/.garminconnect").expanduser()
store.mkdir(parents=True, exist_ok=True)

email = input("Email Garmin Connect: ").strip()
password = getpass.getpass("Password Garmin Connect: ")

garmin = Garmin(email=email, password=password,
                prompt_mfa=lambda: input("Codice MFA ricevuto: ").strip())
garmin.login(str(store))

# Compatibilità tra versioni della libreria: se i token non sono stati salvati, prova a salvarli.
if not any(store.iterdir()):
    for attr in ("garth", "client"):
        obj = getattr(garmin, attr, None)
        if obj is not None and hasattr(obj, "dump"):
            obj.dump(str(store))
            break

files = {p.name: p.read_text() for p in store.iterdir() if p.is_file()}
if not files:
    raise SystemExit("Login riuscito ma nessun token salvato: mandami questo messaggio.")

print("\nLogin riuscito. Copia TUTTA la riga seguente nel secret GARMIN_TOKENS:\n")
print(json.dumps(files))
