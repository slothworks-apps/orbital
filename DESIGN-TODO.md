# Design tuning — zbývající práce

Stav k 2026-09-16 (po třetí ladicí vlně). Reference = export v
`design/Orbital_ celestial agent dashboard/Orbital.dc.html` — obsahuje doslovné
inline CSS všech artboardů (1a–1h); hodnoty brát VŽDY odtud, ne z oka.
Artboardy se renderují přes `npx serve -l 8931` v té složce + Playwright
element screenshot `target: [id="1a"]` (pozor: `#1a` jako CSS selektor nefunguje,
id začíná číslicí). Řádkové rozsahy v exportu: 1g 36–178, 1h 179–223,
1f 224–280, 1a 281–419, 1b 420–579, 1c 580–668, 1d 669–742, 1e 743–konec.

## Ověřeno v prohlížeči (třetí vlna)

Všechny artboardy až na 1c prošly vizuálním srovnáním proti exportu na
1440×900. Screenshoty: `orbital/.playwright-mcp/live6-*`, `live7-*`
(artboardy `~/Projects/slothworks/.playwright-mcp/ab-1a…1h`).

- **1a** sidebar přestavěný na padding rytmus exportu (18px žlaby, 14px
  search/chips, 8px listy), 28×28 collapse tlačítka, crossfade posun 24px,
  HUD readout se animuje s sidebarem 340↔96px, zoom cluster 490px při
  otevřeném detailu.
- **1b** detail panel 450px, usage grid vždy viditelný (bez dat `—`),
  composer jako jedna ohraničená studna, user bubble vs. holý assistant text.
- **1d** New session, **1e** Tags & rules (velký dvousloupcový panel,
  planet-marbles, dashed „+ Add rule", PREVIEW footer), **1g** Clear confirm
  (včetně lineage preview boxu), **1h** Settings (dynamický lineage chain).
- **Stop confirm (1b)** — amber rám, rohové závorky, blikající tečka.
- Sdílené primitivy sjednoceny s exportem: `Panel` per-side sklo
  (left .72/.78 blur22, right .78/.84 blur24, float .88/.94 blur28 r16),
  `Dialog` per-size chrome (440/560/660, tone accent|warning),
  `Button` (700 u plných variant, glow, `accent-outline`, `warning-outline`),
  akcent `#59e4f3`, warning `#ffbb7b`, `orbital-pulse` 1.6s, `orbital-caret`.

Opraveno při ověřování: `Dialog` se portáluje do `<body>` — `backdrop-filter`
na detail panelu z něj dělal containing block, takže Stop/Clear dialog
(renderované z `DetailPanel`) byly uvězněné uvnitř panelu.

Mimo design: `extractMeta` přeskakuje holé slash-commandy (`/clear`, `/login`)
při výběru titulku a indexer si stará taková jména přeindexuje; příkaz
s argumenty (`/clickup-branch CU-123`) zůstává, protože nese téma.

## Čtvrtá vlna (hotovo)

- **1e řádky pravidel** mají dva režimy dle exportu: v klidu text +
  hue pill, po kliknutí se jeden řádek rozbalí do controls s akcentovým
  rámem. Jeden tab stop na klidový řádek (subgrid drží sloupce zarovnané),
  focus po otevření míří do pattern pole, Escape loupe řádek před panelem.
- **Pravidla se nefiltrují.** Vyhodnocují se na serveru shora dolů,
  first match wins, takže zobrazovat jen podmnožinu bylo zavádějící.
  Výběr tagu vlevo je teď jen *označení* (`aria-current` + sr-only marker,
  ne pouze barva) a šipky přeřazují globálně napříč tagy.
- **Idle timeout** se propisuje živě (`PATCH /api/settings` →
  `Runner.setIdleTimeoutMs`), sessions v `needs_input` se přearmují hned
  na plný nový interval. Přibyla volba „Never — only on Clear" přes
  sentinel `'never'`; `parseIdleTimeoutMs` je totální, takže se do
  `setTimeout` nikdy nedostane `NaN`/`0`. Opraveny úniky timerů +
  `Runner.dispose()` na `onClose`.
- **`claude-code <verze>`** se řeší při bootu z `manifest.json` uvnitř
  SDK (= verze bundlovaného CLI, `2.1.272`), NE z `package.json` toho
  balíčku (`0.3.272` je verze SDK). Když to nejde zjistit, řádek se
  ze settings smaže, takže se v UI neukáže.

## Nedodělané / vědomé odchylky

1. **Drag reorder pravidel** — grip ⋮⋮ je jen dekorace (`aria-hidden`),
   pořadí se mění šipkami.
2. **Akcentový rám na editovaném pattern poli** (1e) chybí — `Input`
   má `className` dokumentovaný jako layout-only, takže by to chtělo
   `emphasis`/`accent` prop. Signál zatím nese rám celého řádku.
3. **1c close-up** neporovnán: chybí třetí statický prstenec planety
   (`inset -22`, 24 ticků) a kometový ohon orbit (conic arc maskovaný do
   pásu orbity, alfa .3/.2/.14 podle indexu). 1f — stavová tabulka a
   primární reference — je kreslí obyčejně, proto zatím vynecháno.
4. **1h checkboxy** „Pinned files" a „One-paragraph summary…" nejsou —
   nemá je čím podložit žádný settings klíč.
5. **ToolRow pravá meta** (`0.4s`, `+41 −18`, `exit 1`) a StopDialog `· 4.2s`:
   `ChatMessage` nenese trvání, diffstat ani exit kód.
6. **1b `+ tag` picker** — držíme toggle chipy všech tagů; popover picker je
   nová interakce, ne fidelity práce.
7. **Měsíce** — stavy materializing/idle/needs_input jsou vyrenderované dle
   1f a pokryté testy, ale za běhu nedosažitelné: web sessions neposílají
   subagent WS eventy.
8. **Vlastní přídavky mimo export:** řádek filtru zdroje (all/terminal/web)
   v sidebaru a vstup do Settings (patička sidebaru + spodek railu) — design
   nemá ani jedno.

## Užitečné drobnosti

- Stop/Clear dialogy nejdou naklikat, dokud neexistuje web session. Pro
  vizuální kontrolu se dá dočasně vystavit store
  (`if (import.meta.env.DEV) window.__orbital = useOrbital` na konci
  `store/store.ts`), nasetovat fake session a dialog, a pak to vrátit.
- Barvy z exportu se převádějí přes canvas: `oklch(85% .12 60)` → `#ffbb7b`,
  `oklch(80% .13 60)` → `#fba962`, `oklch(85% .12 205)` → `#59e4f3`.
- Tailwind v4 **nevygeneruje** desetinný arbitrary opacity modifier:
  `bg-accent/[0.06]` mlčky nevyprodukuje žádné pravidlo, `bg-accent/6` ano.
  Nové utility ověřovat skutečným `vite build`, ne jen testy.
- Zákazy: nespouštět sessions/neposílat prompty (token burn), read-only
  browser smoke OK, nezabíjet Tominovy dev servery.
