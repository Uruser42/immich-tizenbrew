# Immich TV

Ein [TizenBrew](https://github.com/reisxd/TizenBrew)-Modul, das [Immich](https://immich.app) auf Samsung-Fernseher und Smart Monitore bringt: Alben, Zeitleiste, Favoriten und eine Diashow, die den Bildschirm zum Bilderrahmen macht. Alles lässt sich mit der Fernbedienung bedienen.

- **Startseite** mit wechselnden Fotos, Uhr und all deinen Alben
- **Raster** für Alben, „Alle Fotos“ und Favoriten, lädt Monat für Monat nach
- **Diashow** mit Überblendung, leichtem Zoom, Uhr, Datum und Ort, auf Wunsch zufällig
- **Videos** werden abgespielt, ⏩/⏪ springen 10 Sekunden

## Installation

1. In TizenBrew die **grüne Taste** drücken und „GitHub-Modul hinzufügen“ wählen.
2. `Uruser42/immich-tizenbrew` eingeben.
3. „Immich TV“ starten und die Adresse deines Immich-Servers eingeben, z. B. `http://192.168.0.50:2283`. Ohne Port wird bei einer IP-Adresse automatisch `:2283` angehängt.
4. Einmal ganz normal bei Immich anmelden. Danach startet jedes Mal direkt die TV-Ansicht.

## Bedienung

| Taste | Startseite / Raster | Einzelbild / Diashow |
| --- | --- | --- |
| Pfeiltasten | Auswahl bewegen | ◀ ▶ blättern, ▲ Infos anheften, ▼ Infos ausblenden |
| OK | Öffnen | Diashow starten/pausieren, Video Play/Pause |
| Play/Pause | Diashow ab der Auswahl | wie OK |
| Zurück | eine Ebene zurück | zurück zum Raster |

In den **Einstellungen** (Kachel auf der Startseite) lassen sich Tempo, Reihenfolge, Zoom-Effekt, Uhr und Videos in der Diashow einstellen, außerdem die Server-Adresse und die Abmeldung.

## Tipps

- **Schärfere Fotos auf 4K-Bildschirmen:** Immich zeigt die Vorschau-Version eines Fotos (Standard: 1440 px). In Immich unter *Administration → Einstellungen → Bildeinstellungen → Vorschau* lässt sich die Auflösung erhöhen, z. B. auf 2160. Danach den Job „Miniaturansichten erzeugen“ für alle Fotos laufen lassen.
- **Bilderrahmen-Betrieb:** Damit der Bildschirm während der Diashow nicht in den Bildschirmschoner oder in „Auto aus“ geht, die Energiespar-Einstellungen am Gerät anpassen.
- **Server nicht erreichbar:** Zurück drücken, dann landest du wieder bei der Adresseingabe.
- Falls du in Immich eine eigene Helmet/CSP-Konfiguration (`IMMICH_HELMET_FILE`) nutzt, muss sie Inline-Styles erlauben.

## So funktioniert's

TizenBrew öffnet zuerst `start.html`. Diese Seite merkt sich die Server-Adresse und leitet weiter. Dann öffnet TizenBrew die Immich-Weboberfläche selbst und spielt `immich-tv.js` dort ein. Sobald man angemeldet ist, legt sich die TV-Oberfläche darüber. Alle Anfragen gehen über dieselbe Adresse und die normale Immich-Anmeldung, deshalb braucht es weder CORS noch einen API-Schlüssel. Das Modul nutzt die Timeline-API von Immich ab Version 1.133, das schließt 2.x und 3.x ein.

## Entwicklung

```bash
npm run check                    # Syntax prüfen
node test/mock-server.js 2399    # Fake-Immich unter http://localhost:2399
```

Die Testseiten spielen Tasten aus der URL ab, z. B. `http://localhost:2399/?keys=down,enter,wait1000,play`. Mit `MOCK_AUTH=0` simuliert der Server den abgemeldeten Zustand. Updates kommen über jsDelivr automatisch auf den Fernseher. Dort gilt ein Cache von bis zu 12 Stunden, den `https://purge.jsdelivr.net/gh/Uruser42/immich-tizenbrew/immich-tv.js` sofort leert.
